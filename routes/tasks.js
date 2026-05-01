const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

async function getUserRole(projectId, userId) {
  const [rows] = await pool.query('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  return rows[0]?.role || null;
}

router.get('/dashboard', async (req, res) => {
  try {
    const userId = req.user.id;
    const [statsRows] = await pool.query(`
      SELECT
        COUNT(*) AS my_tasks,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS my_done,
        SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS my_in_progress,
        SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS my_todo,
        SUM(CASE WHEN t.due_date < NOW() AND t.status != 'done' THEN 1 ELSE 0 END) AS overdue
      FROM tasks t
      JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = ?
      WHERE t.assigned_to = ?
    `, [userId, userId]);

    const [recentTasks] = await pool.query(`
      SELECT t.*, p.name AS project_name, u.name AS assignee_name
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      LEFT JOIN users u ON u.id = t.assigned_to
      JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = ?
      WHERE t.assigned_to = ?
      ORDER BY t.updated_at DESC
      LIMIT 10
    `, [userId, userId]);

    res.json({ stats: statsRows[0], recentTasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

router.get('/project/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const role = await getUserRole(projectId, req.user.id);
  if (!role) return res.status(403).json({ error: 'Access denied.' });

  try {
    const [rows] = await pool.query(`
      SELECT t.*, u.name AS assignee_name, u.email AS assignee_email, c.name AS creator_name
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      LEFT JOIN users c ON c.id = t.created_by
      WHERE t.project_id = ?
      ORDER BY FIELD(t.priority,'high','medium','low'), t.created_at DESC
    `, [projectId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tasks.' });
  }
});

router.post('/project/:projectId', [
  body('title').trim().notEmpty(),
  body('status').optional().isIn(['todo','in_progress','done']),
  body('priority').optional().isIn(['low','medium','high']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { projectId } = req.params;
  const role = await getUserRole(projectId, req.user.id);
  if (!role) return res.status(403).json({ error: 'Access denied.' });

  const { title, description, status, priority, assigned_to, due_date } = req.body;
  try {
    if (assigned_to) {
      const assigneeRole = await getUserRole(projectId, assigned_to);
      if (!assigneeRole) return res.status(400).json({ error: 'Assigned user is not a project member.' });
    }
    const [result] = await pool.query(
      'INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, created_by, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [projectId, title, description || null, status || 'todo', priority || 'medium', assigned_to || null, req.user.id, due_date || null]
    );
    const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task.' });
  }
});

router.put('/:taskId', async (req, res) => {
  const { taskId } = req.params;
  try {
    const [taskRows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (taskRows.length === 0) return res.status(404).json({ error: 'Task not found.' });

    const task = taskRows[0];
    const role = await getUserRole(task.project_id, req.user.id);
    if (!role) return res.status(403).json({ error: 'Access denied.' });
    if (role === 'member' && task.assigned_to !== req.user.id && task.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only update tasks assigned to you.' });
    }

    const { title, description, status, priority, assigned_to, due_date } = req.body;
    await pool.query(
      `UPDATE tasks SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        status = COALESCE(?, status),
        priority = COALESCE(?, priority),
        assigned_to = ?,
        due_date = ?
      WHERE id = ?`,
      [title, description, status, priority,
       assigned_to !== undefined ? assigned_to : task.assigned_to,
       due_date !== undefined ? due_date : task.due_date,
       taskId]
    );
    const [updated] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task.' });
  }
});

router.delete('/:taskId', async (req, res) => {
  const { taskId } = req.params;
  try {
    const [taskRows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (taskRows.length === 0) return res.status(404).json({ error: 'Task not found.' });

    const task = taskRows[0];
    const role = await getUserRole(task.project_id, req.user.id);
    if (!role) return res.status(403).json({ error: 'Access denied.' });
    if (role !== 'admin' && task.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only admins or task creator can delete.' });
    }

    await pool.query('DELETE FROM tasks WHERE id = ?', [taskId]);
    res.json({ message: 'Task deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete task.' });
  }
});

module.exports = router;