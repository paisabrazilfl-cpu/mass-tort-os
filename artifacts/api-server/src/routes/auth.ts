import { Router } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { generateToken, getUserByEmail, createUser, listUsers, authMiddleware, requireRole } from "../lib/rbac";
import { auditLog } from "../lib/audit";

const router = Router();

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please try again later." },
  keyGenerator: (req) => (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown",
});

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(crypto.timingSafeEqual(Buffer.from(hash, "hex"), derivedKey));
    });
  });
}

router.post("/login", authRateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) { res.status(400).json({ error: "Email and password required" }); return; }

  const user = await getUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = generateToken({ id: user.id, email: user.email, name: user.name, role: user.role as any });

  await auditLog("user", String(user.id), "login", { email: user.email }, {
    ip_address: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
  });

  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

router.post("/register", authRateLimit, async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) { res.status(400).json({ error: "Email, password, and name required" }); return; }

  if (password.length < 8) { res.status(400).json({ error: "Password must be at least 8 characters" }); return; }

  const allowedSelfRoles = ["viewer", "paralegal"];
  const assignedRole = (role && allowedSelfRoles.includes(role)) ? role : "viewer";

  const existing = await getUserByEmail(email);
  if (existing) { res.status(409).json({ error: "Email already registered" }); return; }

  const passwordHash = await hashPassword(password);
  const user = await createUser(email, name, assignedRole, passwordHash);
  const token = generateToken(user);

  await auditLog("user", String(user.id), "registered", { email, role: assignedRole });

  res.status(201).json({ token, user });
});

router.get("/me", authMiddleware, (req, res) => {
  res.json(req.user);
});

router.get("/users", authMiddleware, requireRole("admin"), async (_req, res) => {
  const users = await listUsers();
  res.json(users);
});

export default router;
