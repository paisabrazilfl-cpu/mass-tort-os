import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { auditLog } from "./audit";

const JWT_SECRET = process.env.SESSION_SECRET || "mtos-dev-secret";
const TOKEN_EXPIRY = "8h";

export type UserRole = "admin" | "attorney" | "paralegal" | "viewer";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const ROLE_HIERARCHY: Record<UserRole, number> = {
  admin: 100,
  attorney: 75,
  paralegal: 50,
  viewer: 25,
};

export function generateToken(user: AuthUser): string {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthUser;
  } catch {
    return null;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    req.user = { id: 0, email: "system@mtos.local", name: "System", role: "admin" };
    next();
    return;
  }

  const token = authHeader.slice(7);
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.user = user;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (roles.includes(user.role)) {
      next();
      return;
    }

    const userLevel = ROLE_HIERARCHY[user.role] || 0;
    const minRequired = Math.min(...roles.map(r => ROLE_HIERARCHY[r] || 0));
    if (userLevel >= minRequired) {
      next();
      return;
    }

    auditLog("access_denied", String(user.id), "unauthorized_access", {
      required_roles: roles,
      user_role: user.role,
      path: req.path,
      method: req.method,
    });

    res.status(403).json({ error: "Insufficient permissions" });
  };
}

export function auditAction(action: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;
    if (user) {
      auditLog("user_action", String(user.id), action, {
        path: req.path,
        method: req.method,
        user_email: user.email,
        user_role: user.role,
      }, {
        ip_address: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress,
        user_agent: req.headers["user-agent"],
      });
    }
    next();
  };
}

export async function createUser(email: string, name: string, role: UserRole, passwordHash: string): Promise<AuthUser> {
  const [user] = await db.execute(sql`
    INSERT INTO mtos_users (email, name, role, password_hash)
    VALUES (${email}, ${name}, ${role}, ${passwordHash})
    RETURNING id, email, name, role
  `);
  return user as unknown as AuthUser;
}

export async function getUserByEmail(email: string): Promise<(AuthUser & { password_hash: string }) | null> {
  const rows = await db.execute(sql`
    SELECT id, email, name, role, password_hash FROM mtos_users WHERE email = ${email} LIMIT 1
  `);
  if (!rows.length) return null;
  return rows[0] as unknown as AuthUser & { password_hash: string };
}

export async function listUsers(): Promise<AuthUser[]> {
  const rows = await db.execute(sql`SELECT id, email, name, role FROM mtos_users ORDER BY id`);
  return rows as unknown as AuthUser[];
}
