require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');

const app = express();

// MIDDLEWARE
// cors: allows the React frontend (on a different port/domain) to talk to this server
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
// express.json: lets us read JSON data from request bodies
app.use(express.json());

// ROUTES
// Think of these like departments in a building
app.use('/api/auth', require('./routes/auth'));       // Login/Signup department
app.use('/api/projects', require('./routes/projects')); // Projects department
app.use('/api/tasks', require('./routes/tasks'));       // Tasks department

// Health check - Railway uses this to know your app is alive
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 5000;

// Start server AFTER database is ready
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
