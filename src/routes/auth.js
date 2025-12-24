import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "../db.js";

const router = express.Router();

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: "Username and password required" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, username, \"passwordHash\" as password, role FROM users WHERE username=$1 AND \"isActive\"=true",
      [username]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "30m" }
    );

    return res.json({ token, role: user.role });
  } catch (err) {
    // Avoid leaking internals
    return res.status(500).json({ message: "Login failed" });
  }
});

export default router;

