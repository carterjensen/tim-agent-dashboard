#!/usr/bin/env node
/**
 * generate-dashboard.js
 * Regenerates agent-dashboard.html with live data from OpenClaw CLI.
 * Run: node generate-dashboard.js
 * Or:  ./refresh-dashboard.sh
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DASHBOARD = path.join(process.env.HOME, '.openclaw/workspace/agent-dashboard.html');
const TZ = 'America/Chicago';

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch { return ''; }
}

function jsonRun(cmd) {
  const raw = run(cmd);
  try { return JSON.parse(raw); } catch { return []; }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) + ' CST';
}

// ── Agent config ─────────────────────────────────────────────────────────────

const AGENTS = {
  atlas: { avatar: 'avatars/atlas-cookie.png', color: '#667eea', role: 'Research & Analysis' },
  mason: { avatar: 'avatars/mason-oscar.png',  color: '#ed8936', role: 'Browser & Automation' },
  reid:  { avatar: 'avatars/reid-grover.png',  color: '#48bb78', role: 'Curriculum & Content' },
  chase: { avatar: 'avatars/chase-elmo.png',   color: '#9f7aea', role: 'Email & Admin' },
  main:  { avatar: 'avatars/tim-kermit.png',   color: '#e0e0e0', role: 'Coordinator' },
};

// ── Gather data ──────────────────────────────────────────────────────────────

const cronRaw = run('openclaw cron list --json 2>/dev/null');
let cronJobs = [];
try {
  const parsed = JSON.parse(cronRaw);
  cronJobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
} catch {}

const sessionsRaw = run('openclaw sessions --active 60 --json 2>/dev/null');
let activeSessions = [];
try {
  const parsed = JSON.parse(sessionsRaw);
  activeSessions = Array.isArray(parsed) ? parsed : (parsed.sessions || []);
} catch {}

const allSessionsRaw = run('openclaw sessions --json 2>/dev/null');
let allSessions = [];
try {
  const parsed = JSON.parse(allSessionsRaw);
  allSessions = Array.isArray(parsed) ? parsed : (parsed.sessions || []);
} catch {}

// ── Gather subagent sessions across all agents ──────────────────────────────

const OPENCLAW_DIR = path.join(process.env.HOME, '.openclaw');

function getAgentSessions(agentName) {
  const sessFile = path.join(OPENCLAW_DIR, 'agents', agentName, 'sessions', 'sessions.json');
  try {
    return JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  } catch { return {}; }
}

function extractTaskDescription(agentName, sessionId) {
  const transcriptPath = path.join(OPENCLAW_DIR, 'agents', agentName, 'sessions', `${sessionId}.jsonl`);
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const d = JSON.parse(line);
      if (d.type === 'message' && d.message?.role === 'user') {
        const content = d.message.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          const t = content.find(c => c.type === 'text');
          if (t) text = t.text;
        }
        // Strip timestamp prefix like "[Tue 2026-02-10 08:39 CST] "
        text = text.replace(/^\[.*?\]\s*/, '');
        // Take first line or first 120 chars
        const firstLine = text.split('\n')[0].trim();
        return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
      }
    }
  } catch {}
  return null;
}

const agentWorkSessions = [];
const nowMs = Date.now();

for (const agentName of Object.keys(AGENTS)) {
  const sessions = getAgentSessions(agentName);
  for (const [key, meta] of Object.entries(sessions)) {
    // Only subagent and cron:run sessions (skip the main cron session itself)
    const isSubagent = key.includes(':subagent:');
    const isCronRun = key.includes(':cron:') && key.includes(':run:');
    if (!isSubagent && !isCronRun) continue;

    const ageMs = nowMs - (meta.updatedAt || 0);
    const ageMin = Math.round(ageMs / 60000);

    // Only show sessions active in last 120 minutes
    if (ageMin > 120) continue;

    const label = meta.label || null;
    const taskDesc = label || extractTaskDescription(agentName, meta.sessionId) || 'Working...';
    const isActive = ageMin <= 10;

    agentWorkSessions.push({
      agentName,
      key,
      ageMin,
      taskDesc,
      model: meta.model || '?',
      isActive,
      updatedAt: meta.updatedAt || 0,
    });
  }
}

// Also collect 24h sessions per agent for the Task Audit cards
const perAgentTasks = {};  // agentName -> [{taskDesc, ageMin, model, isActive, updatedAt}]

for (const agentName of Object.keys(AGENTS)) {
  perAgentTasks[agentName] = [];
  const sessions = getAgentSessions(agentName);
  for (const [key, meta] of Object.entries(sessions)) {
    const isSubagent = key.includes(':subagent:');
    const isCronRun = key.includes(':cron:') && key.includes(':run:');
    if (!isSubagent && !isCronRun) continue;

    const ageMs = nowMs - (meta.updatedAt || 0);
    const ageMin = Math.round(ageMs / 60000);
    if (ageMin > 1440) continue; // 24h window

    const label = meta.label || null;
    const taskDesc = label || extractTaskDescription(agentName, meta.sessionId) || 'Working...';
    const isActive = ageMin <= 10;

    perAgentTasks[agentName].push({ taskDesc, ageMin, model: meta.model || '?', isActive, updatedAt: meta.updatedAt || 0 });
  }
  perAgentTasks[agentName].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Sort: active first, then by recency
agentWorkSessions.sort((a, b) => {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  return b.updatedAt - a.updatedAt;
});

// ── Build HTML fragments ─────────────────────────────────────────────────────

const now = fmtTime();
const isoNow = new Date().toISOString();

// Stats
const cronCount = cronJobs.length;
const activeAgentCount = agentWorkSessions.filter(s => s.isActive).length;
const activeCount = activeSessions.length;
const totalSessions = allSessions.length;

// Cron table
const cronRows = cronJobs.map(j => {
  const id = (j.id || '').slice(0, 8);
  const name = escHtml(j.name || j.id || 'unnamed');
  const schedule = escHtml(j.schedule || j.cron || '?');
  const agent = escHtml(j.agent || j.target_agent || '?');
  const status = (j.status || 'unknown').toLowerCase();
  const statusLabel = status.toUpperCase();
  const statusColor = status === 'ok' ? '#48bb78' : status === 'error' ? '#fc8181' : '#a0a0a0';
  const next = escHtml(j.next || j.nextRun || '-');
  const last = escHtml(j.last || j.lastRun || '-');
  return `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
    <td style="padding:8px;"><code style="color:#667eea;">${id}</code></td>
    <td style="padding:8px;">${name}</td>
    <td style="padding:8px; font-size:11px;"><code>${schedule}</code></td>
    <td style="padding:8px;">${agent}</td>
    <td style="padding:8px;"><span style="color:${statusColor}; font-weight:600;">● ${statusLabel}</span></td>
    <td style="padding:8px; font-size:12px;">${next}</td>
    <td style="padding:8px; font-size:12px;">${last}</td>
  </tr>`;
}).join('\n');

// Active sessions (legacy list)
const sessionsHtml = activeSessions.length === 0
  ? '<div style="color:#808080; font-style:italic; padding:8px;">No active sessions in the last hour</div>'
  : activeSessions.map(s => {
    const key = escHtml(s.key || s.id || '?');
    const model = escHtml(s.model || '?');
    const age = escHtml(s.age || '?');
    const tokens = escHtml(s.tokens || s.contextTokens || '?');
    return `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
      <span style="color:#e0e0e0; font-size:13px; font-family:monospace;">${key}</span>
      <span style="color:#a0a0a0; font-size:12px;">${model} · ${tokens} · ${age}</span>
    </div>`;
  }).join('\n');

// Agent work sessions (subagents + cron runs)
function formatAge(min) {
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

const agentWorkHtml = agentWorkSessions.length === 0
  ? '<div style="color:#808080; font-style:italic; padding:12px;">No agent work sessions in the last 2 hours</div>'
  : agentWorkSessions.map(s => {
    const agent = AGENTS[s.agentName] || AGENTS.main;
    const statusDot = s.isActive
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#48bb78;margin-right:6px;animation:pulse 2s infinite;"></span>`
      : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#808080;margin-right:6px;"></span>`;
    const nameStyle = `color:${agent.color};font-weight:700;font-size:14px;`;
    const statusLabel = s.isActive ? 'Running' : 'Completed';
    const statusColor = s.isActive ? '#48bb78' : '#808080';
    return `<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;${s.isActive ? 'border-left:3px solid ' + agent.color + ';' : ''}">
      <img src="${agent.avatar}" alt="${s.agentName}" class="agent-avatar" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          ${statusDot}
          <span style="${nameStyle}">${s.agentName.charAt(0).toUpperCase() + s.agentName.slice(1)}</span>
          <span style="color:${statusColor};font-size:11px;font-weight:600;text-transform:uppercase;">${statusLabel}</span>
          <span style="color:#606060;font-size:11px;margin-left:auto;">${formatAge(s.ageMin)}</span>
        </div>
        <div style="color:#c0c0c0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(s.taskDesc)}</div>
        <div style="color:#606060;font-size:10px;margin-top:2px;">${escHtml(s.model)}</div>
      </div>
    </div>`;
  }).join('\n');

// ── Build "Currently Working" section ─────────────────────────────────────────

const activeItems = agentWorkSessions.filter(s => s.isActive);
let activeWorkItems = '';
if (activeItems.length > 0) {
  const itemsHtml = activeItems.map(s => {
    const agent = AGENTS[s.agentName] || AGENTS.main;
    const elapsedSec = Math.round((nowMs - s.updatedAt) / 1000);
    return `<div class="cw-item">
        <div class="cw-spinner" style="border-top-color:${agent.color};"></div>
        <img src="${agent.avatar}" alt="${s.agentName}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="color:${agent.color};font-weight:700;font-size:14px;">${s.agentName.charAt(0).toUpperCase() + s.agentName.slice(1)}</span>
            <span style="background:rgba(72,187,120,0.15);color:#48bb78;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;">⚡ In Progress</span>
          </div>
          <div style="color:#d0d0d0;font-size:13px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(s.taskDesc)}</div>
        </div>
        <div class="cw-elapsed" data-started="${s.updatedAt}">${formatAge(s.ageMin)}</div>
      </div>`;
  }).join('\n');

  activeWorkItems = `<div class="currently-working-card">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-size:18px;">⚙️</span>
        <span style="color:#e0e0e0;font-size:16px;font-weight:700;">Currently Working</span>
        <span style="background:#48bb78;color:#000;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;">${activeItems.length} ACTIVE</span>
      </div>
      ${itemsHtml}
    </div>`;
} else {
  activeWorkItems = `<div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:16px 18px;margin-bottom:16px;text-align:center;">
      <span style="color:#606060;font-size:13px;">✨ All agents idle — no active tasks</span>
    </div>`;
}

// ── Build live panel ─────────────────────────────────────────────────────────

const livePanel = `<div id="live-data-panel" class="org-tier">
  <div class="team-collab-section">
    <h2 class="section-title">⚡ Live System Status <span style="font-size:12px;color:#808080;font-weight:normal;">Auto-updated ${now}</span></h2>
    
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:20px;">
      <div style="background:rgba(102,126,234,0.1);border:1px solid rgba(102,126,234,0.3);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:bold;color:#667eea;">${cronCount}</div>
        <div style="font-size:11px;color:#a0a0a0;margin-top:4px;">Scheduled Jobs</div>
      </div>
      <div style="background:rgba(72,187,120,0.1);border:1px solid rgba(72,187,120,0.3);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:bold;color:#48bb78;">${activeAgentCount}</div>
        <div style="font-size:11px;color:#a0a0a0;margin-top:4px;">Agents Working</div>
      </div>
      <div style="background:rgba(237,137,54,0.1);border:1px solid rgba(237,137,54,0.3);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:bold;color:#ed8936;">${totalSessions}</div>
        <div style="font-size:11px;color:#a0a0a0;margin-top:4px;">Total Sessions</div>
      </div>
      <div style="background:rgba(159,122,234,0.1);border:1px solid rgba(159,122,234,0.3);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:bold;color:#9f7aea;">4</div>
        <div style="font-size:11px;color:#a0a0a0;margin-top:4px;">Agents</div>
      </div>
    </div>

    <style>
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
      @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
      @keyframes glow-pulse{0%,100%{box-shadow:0 0 8px rgba(72,187,120,0.3)}50%{box-shadow:0 0 20px rgba(72,187,120,0.6)}}
      @keyframes slide-glow{0%{background-position:200% 0}100%{background-position:-200% 0}}
      .currently-working-card{background:linear-gradient(135deg,rgba(72,187,120,0.08),rgba(102,126,234,0.05));border:1px solid rgba(72,187,120,0.25);border-radius:14px;padding:16px 18px;margin-bottom:16px;position:relative;overflow:hidden;}
      .currently-working-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#48bb78,#667eea,transparent);background-size:200% 100%;animation:slide-glow 3s linear infinite;}
      .cw-item{display:flex;align-items:center;gap:14px;padding:12px 14px;margin:8px 0;background:rgba(0,0,0,0.2);border:1px solid rgba(72,187,120,0.15);border-radius:10px;animation:glow-pulse 3s ease-in-out infinite;}
      .cw-spinner{width:20px;height:20px;border:2.5px solid rgba(72,187,120,0.2);border-top-color:#48bb78;border-radius:50%;animation:spin 1s linear infinite;flex-shrink:0;}
      .cw-elapsed{font-variant-numeric:tabular-nums;color:#48bb78;font-size:12px;font-weight:600;font-family:monospace;min-width:48px;text-align:right;}
    </style>

    ${activeWorkItems}

    <div class="collab-card">
      <h3 class="collab-heading">🤖 Agent Work Sessions <span style="font-size:11px;color:#808080;font-weight:normal;">(last 2 hours · ${agentWorkSessions.length} total)</span></h3>
      <div class="scrollable-list" style="max-height:320px;overflow-y:auto;padding:4px 0;">
        ${agentWorkHtml}
      </div>
    </div>

    <script>
      (function(){
        function fmtElapsed(ms){
          var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
          if(h>0)return h+'h '+String(m%60).padStart(2,'0')+'m';
          if(m>0)return m+'m '+String(s%60).padStart(2,'0')+'s';
          return s+'s';
        }
        setInterval(function(){
          document.querySelectorAll('.cw-elapsed[data-started]').forEach(function(el){
            var started=parseInt(el.getAttribute('data-started'),10);
            if(started)el.textContent=fmtElapsed(Date.now()-started);
          });
        },1000);
      })();
    </script>

    <div class="collab-card">
      <h3 class="collab-heading">🕐 Active Sessions (Last Hour)</h3>
      <div class="scrollable-list" style="max-height:250px;overflow-y:auto;padding:4px 0;">
        ${sessionsHtml}
      </div>
    </div>
    
    <div class="collab-card">
      <h3 class="collab-heading">📋 All Scheduled Jobs <span style="font-size:11px;color:#808080;font-weight:normal;">(live from openclaw cron list)</span></h3>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid rgba(102,126,234,0.3);">
              <th style="text-align:left;padding:8px;color:#667eea;font-size:11px;text-transform:uppercase;">ID</th>
              <th style="text-align:left;padding:8px;color:#667eea;font-size:11px;text-transform:uppercase;">Name</th>
              <th style="text-align:left;padding:8px;color:#667eea;font-size:11px;text-transform:uppercase;">Schedule</th>
              <th style="text-align:left;padding:8px;color:#667eea;font-size:11px;text-transform:uppercase;">Agent</th>
              <th style="text-align:left;padding:8px;color:#667eea;font-size:11px;text-transform:uppercase;">Status</th>
              <th style="text-align:left;padding:8px;color:#667eea;font-size:11px;text-transform:uppercase;">Next</th>
              <th style="text-align:left;padding:8px;color:#667eea;font-size:11px;text-transform:uppercase;">Last</th>
            </tr>
          </thead>
          <tbody>
            ${cronRows}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>`;

// ── Inject into dashboard ────────────────────────────────────────────────────

let html = fs.readFileSync(DASHBOARD, 'utf8');

// Update timestamp
html = html.replace(/data-last-updated="[^"]*"/, `data-last-updated="${isoNow}"`);

const START = '<!-- LIVE-DATA-START -->';
const END = '<!-- LIVE-DATA-END -->';

if (html.includes(START) && html.includes(END)) {
  // Replace existing
  const si = html.indexOf(START);
  const ei = html.indexOf(END) + END.length;
  html = html.substring(0, si) + START + '\n' + livePanel + '\n' + END + html.substring(ei);
} else {
  // First injection: before Team Collaboration Timeline
  const marker = '<!-- Team Collaboration Timeline -->';
  const idx = html.indexOf(marker);
  if (idx !== -1) {
    html = html.substring(0, idx) + START + '\n' + livePanel + '\n' + END + '\n\n            ' + html.substring(idx);
  } else {
    // Fallback: before <script>
    const si = html.indexOf('<script>');
    if (si !== -1) {
      html = html.substring(0, si) + START + '\n' + livePanel + '\n' + END + '\n\n    ' + html.substring(si);
    }
  }
}

// ── Inject per-agent Task Audit data into agent cards ────────────────────────

function buildTaskAuditHtml(tasks) {
  if (tasks.length === 0) {
    return '<p style="color: #808080; font-style: italic;">No tasks in last 24 hours</p>';
  }
  return tasks.map(t => {
    const timeStr = new Date(t.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
    const statusDot = t.isActive ? '🟢' : '✅';
    return `<div class="task-item">
                                <div class="task-name">${statusDot} ${escHtml(t.taskDesc)}</div>
                                <div class="task-meta">${escHtml(t.model)} · ${formatAge(t.ageMin)} · ${timeStr}</div>
                            </div>`;
  }).join('\n                                ');
}

// Agent name mapping for HTML ids
const agentIdMap = { main: 'tim', atlas: 'atlas', mason: 'mason', reid: 'reid', chase: 'chase' };

for (const [agentName, tasks] of Object.entries(perAgentTasks)) {
  const htmlId = agentIdMap[agentName];
  if (!htmlId) continue;
  const divId = `${htmlId}-tasks`;
  
  // Use comment markers for clean replacement
  const startMarker = `<!-- ${divId}-START -->`;
  const endMarker = `<!-- ${divId}-END -->`;
  
  const newContent = `${startMarker}\n                                ${buildTaskAuditHtml(tasks)}\n                            ${endMarker}`;
  
  if (html.includes(startMarker) && html.includes(endMarker)) {
    // Replace between markers
    const si = html.indexOf(startMarker);
    const ei = html.indexOf(endMarker) + endMarker.length;
    html = html.substring(0, si) + newContent + html.substring(ei);
  } else {
    // First time: replace everything between the opening div tag and its close
    const startTag = `<div class="dropdown-content" id="${divId}">`;
    const si = html.indexOf(startTag);
    if (si === -1) continue;
    
    // Find the next toggle-dropdown button or dropdown-section end as boundary
    const nextToggle = html.indexOf('<button class="toggle-dropdown"', si + startTag.length);
    const nextFileLink = html.indexOf('<a href=', si + startTag.length);
    // Find the </div> just before the next sibling element
    let boundary = nextToggle;
    if (nextFileLink !== -1 && nextFileLink < boundary) boundary = nextFileLink;
    
    // Find the last </div> before the boundary
    let lastDivClose = html.lastIndexOf('</div>', boundary);
    if (lastDivClose <= si) continue;
    
    const replacement = startTag + '\n                                ' + newContent + '\n                            </div>';
    html = html.substring(0, si) + replacement + html.substring(lastDivClose + 6);
  }
}

fs.writeFileSync(DASHBOARD, html);
console.log(`✅ Dashboard updated at ${now} — ${cronCount} jobs, ${activeCount} active sessions, ${totalSessions} total sessions`);
