const jwt = require('jsonwebtoken');
const { pool } = require('../db');

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided.' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

async function requireProjectAdmin(req, res, next) {
  const projectId = req.params.projectId;
  try {
    const [rows] = await pool.query(
      "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
      [projectId, req.user.id]
    );
    if (!rows[0] || rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
}

module.exports = { authenticate, requireProjectAdmin };