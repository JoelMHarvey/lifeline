'use strict';

// Phase 3 noticeboard — the Chatboard replacement (05, 07). Deliberately
// simple: topics with flat posts, pinned topics on top, per-worker unread
// counts. Post bodies are encrypted at rest: notebook entries routinely
// reference service users ("SU may call back for X"). The seeded topics are
// the three TELL actually lives in, including the Protocols topic that
// answers the manual's "review the emergency procedures" checklist step.

const db = require('./db');
const sec = require('./crypto');
const profile = require('./profile');

// The starting topics come from the profile (seed.boardTopics).
const FALLBACK_TOPICS = [
  ['Team notebook', 0],
  ['Coordinator notes', 0],
  ['Protocols & Key Numbers', 1],
];
const defaultTopics = () => profile.profile().seed.boardTopics || FALLBACK_TOPICS;

async function ensureSeeded() {
  const row = await db.get('SELECT id FROM board_topic LIMIT 1');
  if (row) return;
  for (const [name, pinned] of defaultTopics()) {
    await db.run(
      'INSERT INTO board_topic (name, pinned, created_at) VALUES (?,?,?) ON CONFLICT (name) DO NOTHING',
      [name, pinned, db.now()]);
  }
}

// Topic list with unread counts for one worker.
async function topicsFor(workerId) {
  await ensureSeeded();
  const topics = await db.all(
    `SELECT board_topic.*,
            (SELECT COUNT(*) FROM board_post WHERE topic_id = board_topic.id) AS post_count,
            (SELECT MAX(id) FROM board_post WHERE topic_id = board_topic.id) AS last_post_id,
            (SELECT MAX(created_at) FROM board_post WHERE topic_id = board_topic.id) AS last_post_at,
            COALESCE(board_read.last_post_id, 0) AS read_to
     FROM board_topic
     LEFT JOIN board_read ON board_read.topic_id = board_topic.id
       AND board_read.worker_id = ?
     ORDER BY pinned DESC, board_topic.id`, [workerId]);
  const out = [];
  for (const t of topics) {
    const unread = await db.get(
      'SELECT COUNT(*) AS n FROM board_post WHERE topic_id = ? AND id > ?',
      [t.id, Number(t.read_to)]);
    out.push({
      id: Number(t.id), name: t.name, pinned: !!t.pinned,
      postCount: Number(t.post_count), lastPostAt: t.last_post_at,
      unread: Number(unread.n),
    });
  }
  return out;
}

async function unreadTotal(workerId) {
  const topics = await topicsFor(workerId);
  return topics.reduce((n, t) => n + t.unread, 0);
}

// Reading a topic returns its posts (decrypted) and moves the reader's
// read position to the newest post.
async function readTopic(topicId, workerId) {
  const topic = await db.get('SELECT * FROM board_topic WHERE id = ?', [Number(topicId)]);
  if (!topic) return null;
  const posts = await db.all(
    `SELECT board_post.*, worker.name, worker.display_name
     FROM board_post JOIN worker ON worker.id = board_post.worker_id
     WHERE topic_id = ? ORDER BY board_post.id`, [topic.id]);
  const maxId = posts.length ? Number(posts[posts.length - 1].id) : 0;
  await db.run(
    `INSERT INTO board_read (worker_id, topic_id, last_post_id) VALUES (?,?,?)
     ON CONFLICT (worker_id, topic_id) DO UPDATE SET last_post_id = ?`,
    [workerId, topic.id, maxId, maxId]);
  return {
    id: Number(topic.id), name: topic.name, pinned: !!topic.pinned,
    posts: posts.map((p) => ({
      id: Number(p.id), author: p.display_name || p.name,
      body: sec.decrypt(p.body), createdAt: p.created_at,
    })),
  };
}

async function post(topicId, workerId, body) {
  const topic = await db.get('SELECT id FROM board_topic WHERE id = ?', [Number(topicId)]);
  if (!topic) return { error: 'no such topic' };
  const text = String(body || '').trim().slice(0, 8000);
  if (!text) return { error: 'empty post' };
  const id = await db.insert(
    'INSERT INTO board_post (topic_id, worker_id, body, created_at) VALUES (?,?,?,?)',
    [topic.id, workerId, sec.encrypt(text), db.now()]);
  // The author has read their own post.
  await db.run(
    `INSERT INTO board_read (worker_id, topic_id, last_post_id) VALUES (?,?,?)
     ON CONFLICT (worker_id, topic_id) DO UPDATE SET last_post_id = ?`,
    [workerId, topic.id, id, id]);
  await db.eventLog('board_post', { workerId });
  return { id };
}

async function createTopic(name, actorId, pinned = false) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) return { error: 'name required' };
  try {
    const id = await db.insert(
      'INSERT INTO board_topic (name, pinned, created_by, created_at) VALUES (?,?,?,?)',
      [clean, pinned ? 1 : 0, actorId, db.now()]);
    await db.audit(actorId, 'board_topic_created', 'board_topic', id);
    return { id };
  } catch {
    return { error: 'a topic with that name exists' };
  }
}

async function setPinned(topicId, pinned, actorId) {
  const r = await db.run('UPDATE board_topic SET pinned = ? WHERE id = ?',
    [pinned ? 1 : 0, Number(topicId)]);
  if (r.changes) await db.audit(actorId, pinned ? 'board_topic_pinned' : 'board_topic_unpinned',
    'board_topic', Number(topicId));
  return r.changes > 0;
}

module.exports = {
  defaultTopics, ensureSeeded, topicsFor, unreadTotal,
  readTopic, post, createTopic, setPinned,
};
