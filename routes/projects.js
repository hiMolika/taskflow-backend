const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { authenticate, requireProjectAdmin } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        p.id, p.name, p.description, p.created_at,
        pm.role,
        u.name AS owner_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
        (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = p.id) AS member_count
      FROM projects p
      JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
      JOIN users u ON u.id = p.owner_id
      ORDER BY p.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch projects.' });
  }
});

router.post('/', [body('name').trim().notEmpty()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, description } = req.body;
  try {
    const [result] = await pool.query(
      'INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)',
      [name, description || null, req.user.id]
    );
    const projectId = result.insertId;
    await pool.query(
      'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
      [projectId, req.user.id, 'admin']
    );
    const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [projectId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create project.' });
  }
});

router.get('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  try {
    const [memberRows] = await pool.query(
      'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
      [projectId, req.user.id]
    );
    if (memberRows.length === 0) return res.status(403).json({ error: 'Access denied.' });

    const [projectRows] = await pool.query(
      'SELECT p.*, u.name AS owner_name FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?',
      [projectId]
    );
    const [membersRows] = await pool.query(`
      SELECT u.id, u.name, u.email, pm.role, pm.joined_at
      FROM project_members pm
      JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ?
      ORDER BY pm.joined_at ASC
    `, [projectId]);

    res.json({ ...projectRows[0], members: membersRows, userRole: memberRows[0].role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch project.' });
  }
});

router.put('/:projectId', requireProjectAdmin, [body('name').trim().notEmpty()], async (req, res) => {
  const { name, description } = req.body;
  try {
    await pool.query('UPDATE projects SET name = ?, description = ? WHERE id = ?', [name, description || null, req.params.projectId]);
    const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [req.params.projectId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update project.' });
  }
});

router.delete('/:projectId', requireProjectAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM projects WHERE id = ?', [req.params.projectId]);
    res.json({ message: 'Project deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete project.' });
  }
});

router.post('/:projectId/members', requireProjectAdmin, [
  body('email').isEmail(),
  body('role').isIn(['admin', 'member'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, role } = req.body;
  const { projectId } = req.params;
  try {
    const [userRows] = await pool.query('SELECT id, name, email FROM users WHERE email = ?', [email]);
    if (userRows.length === 0) return res.status(404).json({ error: 'No user found with that email.' });

    const user = userRows[0];
    const [existing] = await pool.query('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, user.id]);
    if (existing.length > 0) return res.status(409).json({ error: 'This user is already a member.' });

    await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)', [projectId, user.id, role]);
    res.status(201).json({ message: `${user.name} added as ${role}`, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add member.' });
  }
});

router.delete('/:projectId/members/:userId', requireProjectAdmin, async (req, res) => {
  const { projectId, userId } = req.params;
  try {
    const [adminRows] = await pool.query("SELECT COUNT(*) as count FROM project_members WHERE project_id = ? AND role = 'admin'", [projectId]);
    if (parseInt(adminRows[0].count) === 1 && parseInt(userId) === req.user.id) {
      return res.status(400).json({ error: 'Cannot remove the only admin.' });
    }
    await pool.query('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId]);
    res.json({ message: 'Member removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member.' });
  }
});

module.exports = router;