
const { Pool } = require('pg');
require('dotenv').config(); // For local development to load .env variables

let pool;

if (process.env.DATABASE_URL) {
  // Use DATABASE_URL if provided (common for hosting platforms like Heroku, Render, Neon)
  // Neon connection strings usually include ?sslmode=require
  console.log("Connecting to database using DATABASE_URL with SSL.");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // Necessary for some cloud providers, including Neon, unless you configure CA certs.
                                // For production with specific CAs, you might set this to true and provide CA certs.
    }
  });
} else {
  // Fallback to individual environment variables for local development
  console.log("DATABASE_URL not found. Connecting to database using individual DB_* environment variables.");
  pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    // SSL is typically not configured for local direct connections unless you've set it up specifically.
  });
}

module.exports = pool;
