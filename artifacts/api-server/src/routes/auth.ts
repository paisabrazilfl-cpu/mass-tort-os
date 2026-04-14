import { Router } from "express";
import crypto from "crypto";
import { generateToken, getUserByEmail, createUser, listUsers, authMiddleware, requireRole } from "../lib/rbac";
import { auditLog } from "../lib/audit";

const router = Router();

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  return hash === test;
}

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) { res.status(400).json({ error: "Email and password required" }); return; }

  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
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

router.post("/register", async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) { res.status(400).json({ error: "Email, password, and name required" }); return; }

  const existing = await getUserByEmail(email);
  if (existing) { res.status(409).json({ error: "Email already registered" }); return; }

  const passwordHash = hashPassword(password);
  const user = await createUser(email, name, role || "viewer", passwordHash);
  const token = generateToken(user);

  await auditLog("user", String(user.id), "registered", { email, role: role || "viewer" });

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
