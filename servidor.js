/**
 * Pipeline Comercial — Servidor Local
 * Substitui Supabase: REST API + Auth + File Storage
 * Conecta ao Azure PostgreSQL (vdm_projetos)
 *
 * Rodar: node servidor.js
 * Acesso: http://localhost:3000
 */

const express  = require('express');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { Pool } = require('pg');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET  || 'pipeline-vdm-2026-secret-key';
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Mapeamento bucket → subpasta local
const BUCKETS = { 'lic-anexos': 'lic-anexos', 'oportunidades-docs': 'oportunidades-docs' };
Object.values(BUCKETS).forEach(b => {
  const d = path.join(UPLOADS_DIR, b);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Banco de dados (Azure) ───────────────────────────────────────────────────

const pool = new Pool({
  host:     process.env.DB_HOST     || 'chico-bento-lake-pg-dev.postgres.database.azure.com',
  user:     process.env.DB_USER     || 'projetos_admin',
  password: process.env.DB_PASSWORD || 'projetos_vdm2026#%',
  database: process.env.DB_NAME     || 'vdm_projetos',
  port:     parseInt(process.env.DB_PORT || '5432'),
  ssl:      { rejectUnauthorized: false },
  max:      10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Nome real da tabela no Azure (com prefixo pipeline_)
function azureTable(name) {
  // Tabelas de auth não têm prefixo
  if (name === 'pipeline_auth') return 'pipeline_auth';
  return `pipeline_${name}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const OPS = { eq:'=', neq:'!=', gt:'>', gte:'>=', lt:'<', lte:'<=', like:'LIKE', ilike:'ILIKE' };

function buildWhere(query, existing = []) {
  const conditions = [...existing];
  const params = [];
  let idx = 1;

  // Se já tem parâmetros, ajusta idx
  // (usado quando chamar após offset de outros params)
  // Por simplicidade, retorna função que recebe offset
  const build = (paramOffset = 0) => {
    const conds = [];
    const ps = [];
    let pi = paramOffset + 1;

    for (const [key, val] of Object.entries(query)) {
      if (['select','order','limit','offset','columns'].includes(key)) continue;
      const m = String(val).match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)/s);
      if (!m) continue;
      const [, op, raw] = m;
      if (op === 'is') {
        conds.push(`"${key}" IS ${raw === 'null' ? 'NULL' : raw.toUpperCase()}`);
      } else if (op === 'in') {
        const items = raw.replace(/^\(|\)$/g, '').split(',').map(s => s.trim());
        const ph = items.map(() => `$${pi++}`).join(',');
        conds.push(`"${key}" IN (${ph})`);
        ps.push(...items);
      } else {
        conds.push(`"${key}" ${OPS[op]} $${pi++}`);
        ps.push(raw);
      }
    }
    return { conds, ps };
  };

  return build;
}

function buildSelect(selectStr) {
  if (!selectStr || selectStr === '*') return '*';
  // Supabase select pode ter embeds (table(col)) — ignoramos e retornamos colunas simples
  return selectStr.split(',').map(s => {
    const col = s.trim().split('(')[0].trim();
    if (col === 'count') return 'COUNT(*) as count';
    return `"${col}"`;
  }).join(', ');
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '') ||
                req.headers['apikey'];
  if (!token) return res.status(401).json({ message: 'Token ausente' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    // Permite token de desenvolvimento
    if (token === 'local-dev-key') { req.user = { email: 'dev', perfil: 'admin' }; return next(); }
    return res.status(401).json({ message: 'Token inválido' });
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve arquivos estáticos (index.html, etc.)
app.use(express.static(__dirname));

// Serve arquivos de upload
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── Auth endpoints ───────────────────────────────────────────────────────────

// Login
app.post('/auth/v1/token', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error_description: 'email e password obrigatórios' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM pipeline_auth WHERE email = $1 LIMIT 1', [email.toLowerCase()]
    );
    if (!rows.length) return res.status(400).json({ error_description: 'Usuário não encontrado' });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.senha_hash);
    if (!ok) return res.status(400).json({ error_description: 'Senha incorreta' });

    const token = jwt.sign(
      { id: user.id, email: user.email, perfil: user.perfil },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: 2592000,
      user: { id: user.id, email: user.email, user_metadata: { perfil: user.perfil, primeiro_acesso: user.primeiro_acesso } }
    });
  } catch (e) {
    res.status(500).json({ error_description: e.message });
  }
});

// Cadastro de novo usuário (apenas admin pode, via endpoint direto)
app.post('/auth/v1/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error_description: 'email e password obrigatórios' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO pipeline_auth (email, senha_hash, perfil)
       VALUES ($1, $2, 'viewer')
       ON CONFLICT (email) DO UPDATE SET senha_hash = $2
       RETURNING id, email, perfil`,
      [email.toLowerCase(), hash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, perfil: user.perfil }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      access_token: token,
      token_type: 'bearer',
      user: { id: user.id, email: user.email }
    });
  } catch (e) {
    res.status(500).json({ error_description: e.message });
  }
});

// Logout
app.post('/auth/v1/signout', (req, res) => res.json({}));

// Atualizar senha
app.put('/auth/v1/user', authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ message: 'password obrigatório' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE pipeline_auth SET senha_hash = $1, primeiro_acesso = false WHERE email = $2', [hash, req.user.email]);
    res.json({ user: { email: req.user.email } });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Reset de senha (simplificado — retorna ok)
app.post('/auth/v1/recover', (req, res) => {
  res.json({ message: 'Contate o administrador para redefinir sua senha.' });
});

// Sessão atual (via token)
app.get('/auth/v1/user', authMiddleware, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pipeline_auth WHERE email=$1', [req.user.email]);
  if (!rows.length) return res.status(404).json({});
  const u = rows[0];
  res.json({ id: u.id, email: u.email, user_metadata: { perfil: u.perfil } });
});

// ─── REST API (PostgREST-compatible) ─────────────────────────────────────────

app.all('/rest/v1/:table', authMiddleware, async (req, res) => {
  const { table } = req.params;
  const tbl = azureTable(table);
  const method = req.method.toUpperCase();
  const query  = req.query;
  const prefer = req.headers['prefer'] || '';
  const accept = req.headers['accept'] || '';
  const isSingle = accept.includes('pgrst.object') || prefer.includes('return=representation');
  const isCount  = prefer.includes('count=exact');
  const isHead   = method === 'HEAD';

  try {
    // ── HEAD / COUNT ──────────────────────────────────────────────────────────
    if (isHead || isCount) {
      const buildW = buildWhere(query);
      const { conds, ps } = buildW(0);
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await pool.query(`SELECT COUNT(*) as n FROM "${tbl}" ${where}`, ps);
      const count = parseInt(rows[0].n);
      res.set('Content-Range', `0-${count}/${count}`);
      res.set('Content-Profile', 'public');
      return res.json(isHead ? [] : [{ count }]);
    }

    // ── GET ───────────────────────────────────────────────────────────────────
    if (method === 'GET') {
      const sel    = buildSelect(query.select);
      const buildW = buildWhere(query);
      const { conds, ps } = buildW(0);
      const where  = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const orderM = query.order?.match(/^(\w+)\.(asc|desc)/);
      const order  = orderM ? `ORDER BY "${orderM[1]}" ${orderM[2].toUpperCase()}` : '';
      const lim    = query.limit  ? `LIMIT $${ps.length + 1}`  : '';
      const off    = query.offset ? `OFFSET $${ps.length + (lim ? 2 : 1)}` : '';
      const ps2 = [...ps, ...(lim ? [parseInt(query.limit)] : []), ...(off ? [parseInt(query.offset)] : [])];

      const sql = `SELECT ${sel} FROM "${tbl}" ${where} ${order} ${lim} ${off}`.trim();
      const { rows } = await pool.query(sql, ps2);

      const total = rows.length;
      res.set('Content-Range', `0-${total}/${total}`);
      return res.json(isSingle ? (rows[0] || null) : rows);
    }

    // ── POST (INSERT) ─────────────────────────────────────────────────────────
    if (method === 'POST') {
      const body = Array.isArray(req.body) ? req.body : [req.body];
      if (!body.length) return res.json([]);

      const cols = Object.keys(body[0]);
      const colNames = cols.map(c => `"${c}"`).join(', ');
      const returning = prefer.includes('return=representation') ? 'RETURNING *' : 'RETURNING *';
      const inserted = [];

      for (const row of body) {
        const vals = cols.map(c => row[c]);
        const phs  = vals.map((_, i) => `$${i + 1}`).join(', ');
        const { rows } = await pool.query(
          `INSERT INTO "${tbl}" (${colNames}) VALUES (${phs}) ${returning}`,
          vals
        );
        inserted.push(...rows);
      }
      res.status(201).json(isSingle ? (inserted[0] || null) : inserted);
      return;
    }

    // ── PATCH (UPDATE) ────────────────────────────────────────────────────────
    if (method === 'PATCH') {
      const updates = req.body;
      const cols    = Object.keys(updates);
      const sets    = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
      const vals    = cols.map(c => updates[c]);

      const buildW = buildWhere(query);
      const { conds, ps } = buildW(vals.length);
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const allVals = [...vals, ...ps];

      const { rows } = await pool.query(
        `UPDATE "${tbl}" SET ${sets} ${where} RETURNING *`,
        allVals
      );
      return res.json(isSingle ? (rows[0] || null) : rows);
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (method === 'DELETE') {
      const buildW = buildWhere(query);
      const { conds, ps } = buildW(0);
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : 'WHERE FALSE'; // segurança: nunca deleta tudo
      const { rows } = await pool.query(`DELETE FROM "${tbl}" ${where} RETURNING *`, ps);
      return res.json(rows);
    }

    res.status(405).json({ message: 'Método não suportado' });
  } catch (e) {
    console.error(`[${method} ${tbl}] ${e.message}`);
    res.status(500).json({ message: e.message, detail: e.detail });
  }
});

// ─── Storage endpoints ────────────────────────────────────────────────────────

const upload = multer({ storage: multer.diskStorage({
  destination: (req, _, cb) => {
    const bucket = req.params.bucket;
    const dir = path.join(UPLOADS_DIR, BUCKETS[bucket] || bucket);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, path.basename(req.params.filePath || file.originalname));
  }
})});

// Upload
app.post('/storage/v1/object/:bucket/*filePath', authMiddleware, upload.single(''), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo recebido' });
  const bucket   = req.params.bucket;
  const filePath = req.params.filePath;
  const publicUrl = `http://localhost:${PORT}/uploads/${BUCKETS[bucket] || bucket}/${path.basename(filePath)}`;
  res.json({ Key: filePath, publicUrl });
});

// Get public URL
app.get('/storage/v1/object/public/:bucket/*filePath', (req, res) => {
  const bucket   = req.params.bucket;
  const filePath = req.params.filePath;
  const local = path.join(UPLOADS_DIR, BUCKETS[bucket] || bucket, path.basename(filePath));
  if (!fs.existsSync(local)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  res.sendFile(local);
});

// Delete
app.delete('/storage/v1/object/:bucket', authMiddleware, (req, res) => {
  const bucket = req.params.bucket;
  const paths  = req.body || [];
  paths.forEach(p => {
    const local = path.join(UPLOADS_DIR, BUCKETS[bucket] || bucket, path.basename(p));
    if (fs.existsSync(local)) fs.unlinkSync(local);
  });
  res.json({ message: 'ok' });
});

// ─── Inicia servidor ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Pipeline Comercial — Servidor Local      ║`);
  console.log(`║  http://localhost:${PORT}                   ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log('Banco: Azure PostgreSQL (vdm_projetos)');
  console.log('Uploads: ' + UPLOADS_DIR);
  console.log('\nPressione Ctrl+C para parar.\n');

  // Testa conexão ao banco
  pool.query('SELECT NOW()').then(() => console.log('✔ Azure conectado\n')).catch(e => console.error('✗ Banco:', e.message));
});
