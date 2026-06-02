const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: '.env.local' });
dotenv.config();

async function checkSchema() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    try {
        await client.connect();
        const res = await client.query(`
            SELECT table_name, column_name 
            FROM information_schema.columns 
            WHERE table_name IN ('restaurant_sync_states', 'restaurant_sync_batches', 'sync_cursors')
            ORDER BY table_name, ordinal_position;
        `);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}
checkSchema();
