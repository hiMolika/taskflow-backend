const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

async function getUserRole(projectId, userId) {
  const result = await pool.query('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
  return result.rows[0]?.role || null;
}

router.get('/dashboard', async (req, res) => {
  try {
    const userId = req.user.id;
    const statsResult = await pool.query(`
      SELECT
        COUNT(*) AS my_tasks,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS my_done,
        SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS my_in_progress,
        SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS my_todo,
        SUM(CASE WHEN t.due_date < NOW() AND t.status != 'done' THEN 1 ELSE 0 END) AS overdue
      FROM tasks t
      JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = $1
      WHERE t.assigned_to = $2
    `, [userId, userId]);

    const recentResult = await pool.query(`
      SELECT t.*, p.name AS project_name, u.name AS assignee_name
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      LEFT JOIN users u ON u.id = t.assigned_to
      JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = $1
      WHERE t.assigned_to = $2
      ORDER BY t.updated_at DESC
      LIMIT 10
    `, [userId, userId]);

    res.json({ stats: statsResult.rows[0], recentTasks: recentResult.rows });
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
    const result = await pool.query(`
      SELECT t.*, u.name AS assignee_name, u.email AS assignee_email, c.name AS creator_name
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      LEFT JOIN users c ON c.id = t.created_by
      WHERE t.project_id = $1
      ORDER BY t.created_at DESC
    `, [projectId]);
    res.json(result.rows);
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
    const result = await pool.query(
      'INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, created_by, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [projectId, title, description || null, status || 'todo', priority || 'medium', assigned_to || null, req.user.id, due_date || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task.' });
  }
});

router.put('/:taskId', async (req, res) => {
  const { taskId } = req.params;
  try {
    const taskResult = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found.' });

    const task = taskResult.rows[0];
    const role = await getUserRole(task.project_id, req.user.id);
    if (!role) return res.status(403).json({ error: 'Access denied.' });
    if (role === 'member' && task.assigned_to !== req.user.id && task.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only update tasks assigned to you.' });
    }

    const { title, description, status, priority, assigned_to, due_date } = req.body;
    const updated = await pool.query(
      `UPDATE tasks SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        status = COALESCE($3, status),
        priority = COALESCE($4, priority),
        assigned_to = $5,
        due_date = $6,
        updated_at = NOW()
      WHERE id = $7 RETURNING *`,
      [title, description, status, priority,
       assigned_to !== undefined ? assigned_to : task.assigned_to,
       due_date !== undefined ? due_date : task.due_date,
       taskId]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update task.' });
  }
});

router.delete('/:taskId', async (req, res) => {
  const { taskId } = req.params;
  try {
    const taskResult = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found.' });

    const task = taskResult.rows[0];
    const role = await getUserRole(task.project_id, req.user.id);
    if (!role) return res.status(403).json({ error: 'Access denied.' });
    if (role !== 'admin' && task.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only admins or task creator can delete.' });
    }

    await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    res.json({ message: 'Task deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete task.' });
  }
});

module.exports = router;