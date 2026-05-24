import { useState, useEffect } from 'react';
import { supabase, fetchCommunityPosts } from '../lib/supabase';

const URL_PATTERN = /https?:\/\/|www\.|[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/;

// Dashboard visitors get their own anonymous ID stored in localStorage.
// This is separate from (and doesn't conflict with) the extension's anonymous ID.
function getDashboardAnonId() {
  if (typeof window === 'undefined') return null;
  const KEY = 'cw_dashboard_anon_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    // crypto.randomUUID() is available in all modern browsers
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Community() {
  const [posts, setPosts] = useState([]);
  const [sort, setSort] = useState('newest');
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      setPosts(await fetchCommunityPosts(sort));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [sort]);

  async function handlePost() {
    setError('');
    if (!content.trim()) return;
    if (content.length > 280) { setError('Max 280 characters.'); return; }
    if (URL_PATTERN.test(content)) { setError('Links are not allowed.'); return; }

    setPosting(true);
    const anonId = getDashboardAnonId();
    const { error: err } = await supabase
      .from('community_posts')
      .insert({ content: content.trim(), anonymous_id: anonId });
    setPosting(false);

    if (err) {
      setError(err.message || 'Post failed. Daily limit may be reached.');
    } else {
      setContent('');
      load();
    }
  }

  async function vote(id, dir) {
    await supabase.rpc('vote_post', { post_id: id, direction: dir });
    load();
  }

  async function flag(id) {
    const anonId = getDashboardAnonId();
    await supabase.rpc('flag_post', { post_id: id, flagging_anon_id: anonId });
    load();
  }

  return (
    <div className="page">
      <header className="header">
        <a href="/" className="logo">ClaudeWatch</a>
        <nav className="nav">
          <a href="/" className="nav-link">Dashboard</a>
          <a href="/community" className="nav-link active">Community</a>
        </nav>
      </header>

      <h2 className="page-title">Community Board</h2>
      <p className="page-sub">Anonymous observations from ClaudeWatch users. No account needed.</p>

      <div className="compose">
        <textarea
          className="compose-input"
          value={content}
          onChange={e => setContent(e.target.value)}
          maxLength={280}
          placeholder="Share an observation about Claude usage or limits (280 chars, no links)…"
          rows={3}
        />
        <div className="compose-footer">
          <span className={`char-count ${content.length > 240 ? 'near' : ''}`}>{content.length} / 280</span>
          {error && <span className="err">{error}</span>}
          <button className="btn-post" onClick={handlePost} disabled={posting || !content.trim()}>
            {posting ? 'Posting…' : 'Post anonymously'}
          </button>
        </div>
      </div>

      <div className="sort-row">
        <button className={`sort-btn ${sort === 'newest' ? 'active' : ''}`} onClick={() => setSort('newest')}>Newest</button>
        <button className={`sort-btn ${sort === 'top' ? 'active' : ''}`} onClick={() => setSort('top')}>Most upvoted</button>
      </div>

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <div className="posts">
          {posts.length === 0 && <div className="empty">No posts yet. Be the first!</div>}
          {posts.map(post => (
            <div key={post.id} className="post">
              <div className="post-content">{post.content}</div>
              <div className="post-footer">
                <span className="post-age">{timeAgo(post.created_at)}</span>
                {post.display_name && <span className="post-name">{post.display_name}</span>}
                <div className="post-actions">
                  <button className="vote up" onClick={() => vote(post.id, 'up')}>▲ {post.upvotes}</button>
                  <button className="vote down" onClick={() => vote(post.id, 'down')}>▼ {post.downvotes}</button>
                  <button className="flag-btn" onClick={() => flag(post.id)}>flag</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <style jsx global>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #111; color: #e0e0e0; font-family: -apple-system, sans-serif; font-size: 14px; }
        a { color: inherit; text-decoration: none; }
      `}</style>

      <style jsx>{`
        .page { max-width: 720px; margin: 0 auto; padding: 20px; }
        .header { display: flex; align-items: center; gap: 24px; margin-bottom: 28px; }
        .logo { font-family: 'Fira Mono', monospace; font-size: 18px; color: #7ab; }
        .nav { display: flex; gap: 16px; }
        .nav-link { color: #888; font-size: 13px; }
        .nav-link.active, .nav-link:hover { color: #e0e0e0; }
        .page-title { font-size: 20px; margin-bottom: 6px; }
        .page-sub { font-size: 13px; color: #666; margin-bottom: 20px; }
        .compose { background: #1a1a1a; border: 1px solid #2d2d2d; border-radius: 8px; overflow: hidden; margin-bottom: 20px; }
        .compose-input { width: 100%; background: transparent; border: none; color: #e0e0e0; font-family: inherit; font-size: 13px; padding: 12px 14px; resize: none; outline: none; }
        .compose-input::placeholder { color: #555; }
        .compose-footer { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid #2d2d2d; }
        .char-count { font-family: 'Fira Mono', monospace; font-size: 11px; color: #555; }
        .char-count.near { color: #c77; }
        .err { font-size: 12px; color: #c77; flex: 1; }
        .btn-post { margin-left: auto; background: #7ab; border: none; border-radius: 4px; color: #111; cursor: pointer; font-size: 12px; font-weight: 700; padding: 5px 12px; }
        .btn-post:disabled { opacity: 0.4; cursor: not-allowed; }
        .sort-row { display: flex; gap: 8px; margin-bottom: 16px; }
        .sort-btn { background: #1a1a1a; border: 1px solid #2d2d2d; border-radius: 4px; color: #888; cursor: pointer; font-size: 12px; padding: 4px 10px; }
        .sort-btn.active { border-color: #7ab; color: #7ab; }
        .posts { display: flex; flex-direction: column; gap: 10px; }
        .post { background: #1a1a1a; border: 1px solid #2d2d2d; border-radius: 7px; padding: 12px 14px; }
        .post-content { font-size: 13px; line-height: 1.5; word-break: break-word; }
        .post-footer { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
        .post-age { font-size: 11px; color: #555; font-family: 'Fira Mono', monospace; }
        .post-name { font-size: 11px; color: #7ab; }
        .post-actions { margin-left: auto; display: flex; gap: 6px; }
        .vote { background: none; border: 1px solid #2d2d2d; border-radius: 3px; color: #666; cursor: pointer; font-family: 'Fira Mono', monospace; font-size: 11px; padding: 2px 6px; }
        .vote.up:hover { color: #7c7; }
        .vote.down:hover { color: #c77; }
        .flag-btn { background: none; border: none; color: #444; cursor: pointer; font-size: 11px; }
        .flag-btn:hover { color: #c77; }
        .loading, .empty { text-align: center; color: #555; padding: 32px 0; font-size: 13px; }
      `}</style>
    </div>
  );
}
