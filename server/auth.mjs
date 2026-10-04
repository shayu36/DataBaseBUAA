import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { AppError, ledgerTransaction } from "./db.mjs";
const publicUser = ({ id, name, email, phone, role, status }) => ({
  id,
  name,
  email,
  phone,
  role,
  status,
});
const password = z
  .string()
  .min(8)
  .max(72)
  .regex(/[a-zA-Z]/)
  .regex(/[0-9]/)
  .refine((v) => Buffer.byteLength(v, "utf8") <= 72, "密码最多72字节");
export const credentials = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(160)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(72),
});
const registration = credentials.extend({
  name: z.string().trim().min(1).max(40),
  phone: z.string().regex(/^1[3-9][0-9]{9}$/),
  password,
});
const cookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.COOKIE_SECURE === "true",
  path: "/",
};
function secret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
    throw new Error("JWT_SECRET must contain at least 32 characters");
  return process.env.JWT_SECRET;
}
export function issueCookie(res, user) {
  res.cookie(
    "qingxing_session",
    jwt.sign({ sub: String(user.id) }, secret(), {
      algorithm: "HS256",
      expiresIn: "8h",
      issuer: "qingxing-local",
      audience: "qingxing-browser",
    }),
    { ...cookieOptions, maxAge: 28800000 },
  );
}
export function logout(res) {
  res.clearCookie("qingxing_session", cookieOptions);
}
export function authenticate(pool) {
  return async (req, res, next) => {
    try {
      const p = jwt.verify(req.cookies.qingxing_session || "", secret(), {
        algorithms: ["HS256"],
        issuer: "qingxing-local",
        audience: "qingxing-browser",
      });
      const [[user]] = await pool.query(
        "SELECT id,name,email,phone,role,status FROM users WHERE id=?",
        [p.sub],
      );
      if (!user)
        return res
          .status(401)
          .json({ error: "请先登录", code: "UNAUTHORIZED" });
      if (user.status !== "ACTIVE")
        return res.status(403).json({
          error: "账号已停用，请联系管理员",
          code: "ACCOUNT_SUSPENDED",
        });
      req.user = user;
      next();
    } catch (e) {
      if (e instanceof jwt.JsonWebTokenError)
        return res
          .status(401)
          .json({ error: "登录已过期，请重新登录", code: "UNAUTHORIZED" });
      next(e);
    }
  };
}
export async function login(pool, input) {
  const d = credentials.parse(input),
    [[u]] = await pool.query("SELECT * FROM users WHERE email=?", [d.email]);
  const hash =
    u?.password_hash ||
    "$2b$10$UqCF9JK7suMSoujx.zcj1OJSP57L8J.WWGi20STf2LTTNvLG0bTym";
  const valid = await bcrypt.compare(d.password, hash);
  if (!u || !valid)
    throw new AppError("邮箱或密码不正确", "BAD_CREDENTIALS", 401);
  if (u.status !== "ACTIVE")
    throw new AppError("账号已停用", "ACCOUNT_SUSPENDED", 403);
  return publicUser(u);
}
export async function register(pool, input) {
  const d = registration.parse(input),
    hash = await bcrypt.hash(d.password, 10);
  return ledgerTransaction(pool, async (c) => {
    try {
      const [r] = await c.query(
        "INSERT INTO users(name,email,phone,password_hash) VALUES(?,?,?,?)",
        [d.name, d.email, d.phone, hash],
      );
      return {
        id: r.insertId,
        name: d.name,
        email: d.email,
        phone: d.phone,
        role: "STUDENT",
        status: "ACTIVE",
      };
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY")
        throw new AppError("邮箱或手机号已注册", "ACCOUNT_EXISTS", 409);
      throw e;
    }
  });
}
