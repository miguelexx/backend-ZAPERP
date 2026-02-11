const { Pool } = require('pg');

// Opcional: o projeto usa Supabase. Use este pool apenas se precisar de PostgreSQL direto.
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DATABASE || 'whatsapp_plataforma',
  port: Number(process.env.PG_PORT) || 5432,
});

module.exports = pool;
