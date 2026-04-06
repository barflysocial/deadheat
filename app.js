const ROUND_CONFIG = {"firstSceneByRound": {"1": "scene_001_body_position", "2": "scene_005_rider_accounts", "3": "scene_008_horse_condition", "4": "scene_011_money_pressure", "5": "scene_014_medical_reconstruction"}, "checkpointByRound": {"1": "scene_004_checkpoint", "2": "scene_007_checkpoint", "3": "scene_010_checkpoint", "4": "scene_013_checkpoint", "5": "scene_016_checkpoint"}, "requiredByRound": {"1": ["scene_001_body_position", "scene_002_tack_area", "scene_003_public_conflict"], "2": ["scene_005_rider_accounts", "scene_006_stable_logs"], "3": ["scene_008_horse_condition", "scene_009_prep_records"], "4": ["scene_011_money_pressure", "scene_012_late_wraps"], "5": ["scene_014_medical_reconstruction", "scene_015_route_reconstruction", "scene_016_final"]}};

let game = null;
let started = false;
let timerInterval = null;
let checkpointAdvanceTimer = null;
let resultFlowTimer = null;
let resultCountdownTimer = null;
let roundDelayCountdownTimer = null;

const state = {
  currentSceneId: null,
  currentTab: 'home',
  score: 0,
  flags: new Set(),
  evidence: new Set(),
  visitedScenes: new Set(),
  usedHints: {},
  interviewState: {},
  releasedTimedEvidence: {},
  checkpointResults: {},
  selectedCheckpointAnswers: {},
  finalAnswers: {},
  finalResult: null,
  finalSubmitted: false,
  unlockState: null,
  resultOverlay: null,
  resultCountdownSec: 0,
  roundDelayOverlay: null,
  roundDelayCountdownSec: 0,
  activeInterviewId: null,
  playerName: '',
  startedAt: null,
  penaltiesSec: 0,
  timerSeconds: 0,
  attempts: 0
};

const PENALTIES = { hint:60, wrongCheckpoint:90, wrongKiller:300, wrongMotive:120, wrongMethod:120, wrongProof:60 };
const CHECKPOINT_ADVANCE_DELAY_MS = 10000;
const UNLOCK_HOLD_MS = 10000;
const ROUND_DELAY_COUNTDOWN_MS = 1000;
const ROUND_MIN_UNLOCK_SECONDS = { 1: 0, 2: 360, 3: 720, 4: 1080, 5: 1440 };
const TIMED_EVIDENCE_RELEASES = [
  { sec: 240, evidence: ['service_corridor_camera_gap'], label: 'Camera review unlocked' },
  { sec: 600, evidence: ['vet_clearance_addendum'], label: 'Vet clearance addendum received' },
  { sec: 960, evidence: ['tommys_odds_call_note'], label: 'Betting note released' },
  { sec: 1320, evidence: ['preimpact_incapacitation'], label: 'Medical finding released' }
];
const RUN_SAVE_KEY = 'case004_dead_heat_active_run';
const TIMED_TOPIC_RELEASES = {
  marlon_corridor: 480,
  diane_clearance: 660,
  eddie_timeline_change: 720,
  tommy_staff_contact: 1020
};

const el = {
  heroTitle: document.getElementById('heroTitle'),
  heroSub: document.getElementById('heroSub'),
  difficultyLabel: document.getElementById('difficultyLabel'),
  startBtn: document.getElementById('startBtn'),
  roundLabel: document.getElementById('roundLabel'),
  elapsedLabel: document.getElementById('elapsedLabel'),
  penaltyLabel: document.getElementById('penaltyLabel'),
  finalTimeLabel: document.getElementById('finalTimeLabel'),
  finalTimeCard: document.getElementById('finalTimeCard'),
  attemptLabel: document.getElementById('attemptLabel'),
  heroStoryline: document.getElementById('heroStoryline'),
  heroInstructions: document.getElementById('heroInstructions'),
  mainNav: document.getElementById('mainNav'),
  hintBtn: document.getElementById('hintBtn'),
  checkpointBtn: document.getElementById('checkpointBtn'),
  attemptBtn: document.getElementById('attemptBtn'),
  hintBox: document.getElementById('hintBox'),
  playerNameInput: document.getElementById('playerNameInput'),
  panel: document.getElementById('panel')
};

const NAV_ITEMS = [
  { id: 'scene', label: 'Scene' },
  { id: 'clues', label: 'Clues' },
  { id: 'suspects', label: 'Suspects' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'interviews', label: 'Interviews' },
  { id: 'updates', label: 'Updates' }
];

function escapeHtml(text=''){ return String(text).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function escapeJs(text=''){ return String(text).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function sceneMap(){ return game?.scenes || {}; }
function evidenceEntries(){
  const raw = game?.evidence || {};
  if(Array.isArray(raw)) return raw.map((e, idx) => ({ id: e.id || `evidence_${idx}`, ...e }));
  return Object.entries(raw).map(([id, e]) => ({ id, ...e }));
}
function interviewMap(){ return game?.interviews || {}; }
function currentScene(){ return sceneMap()[state.currentSceneId] || null; }
function currentRound(){
  const s = currentScene();
  const r = s?.round;
  if(typeof r === 'number') return r;
  if(state.flags.has('round_5_complete')) return 'Final';
  if(state.flags.has('round_4_complete')) return 5;
  if(state.flags.has('round_3_complete')) return 4;
  if(state.flags.has('round_2_complete')) return 3;
  if(state.flags.has('round_1_complete')) return 2;
  return 1;
}
function hasFlags(flags=[]){ return flags.every(f=>state.flags.has(f)); }
function hasEvidence(ids=[]){ return ids.every(id=>state.evidence.has(id)); }
function roundSceneIds(round){ return ROUND_CONFIG.requiredByRound[String(round)] || []; }
function checkpointSceneId(round){ return ROUND_CONFIG.checkpointByRound[String(round)] || null; }
function firstSceneForRound(round){ return ROUND_CONFIG.firstSceneByRound[String(round)] || null; }
function checkpointUnlocked(round){ return roundSceneIds(round).every(id => state.visitedScenes.has(id)); }

function roundMinUnlockSeconds(round){
  return ROUND_MIN_UNLOCK_SECONDS[round] ?? 0;
}
function roundTimeRemaining(round){
  return Math.max(0, roundMinUnlockSeconds(round) - state.timerSeconds);
}
function formatUnlockCountdown(sec){
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function roundTimeUnlocked(round){
  return state.timerSeconds >= roundMinUnlockSeconds(round);
}
function timedEvidenceRemainingForRound(round){
  const ranges = {
    1: TIMED_EVIDENCE_RELEASES.filter(r => r.sec <= 360),
    2: TIMED_EVIDENCE_RELEASES.filter(r => r.sec > 360 && r.sec <= 720),
    3: TIMED_EVIDENCE_RELEASES.filter(r => r.sec > 720 && r.sec <= 1080),
    4: TIMED_EVIDENCE_RELEASES.filter(r => r.sec > 1080 && r.sec <= 1440),
    5: TIMED_EVIDENCE_RELEASES.filter(r => r.sec > 1440)
  };
  const arr = ranges[round] || [];
  return arr.filter(r => state.timerSeconds < r.sec);
}
function timedTopicsRemainingForRound(round){
  const ranges = {
    1: Object.entries(TIMED_TOPIC_RELEASES).filter(([_,sec]) => sec <= 360),
    2: Object.entries(TIMED_TOPIC_RELEASES).filter(([_,sec]) => sec > 360 && sec <= 720),
    3: Object.entries(TIMED_TOPIC_RELEASES).filter(([_,sec]) => sec > 720 && sec <= 1080),
    4: Object.entries(TIMED_TOPIC_RELEASES).filter(([_,sec]) => sec > 1080 && sec <= 1440),
    5: Object.entries(TIMED_TOPIC_RELEASES).filter(([_,sec]) => sec > 1440)
  };
  return (ranges[round] || []).filter(([_,sec]) => state.timerSeconds < sec);
}
function timedRoundFullyReleased(round){
  return timedEvidenceRemainingForRound(round).length === 0 && timedTopicsRemainingForRound(round).length === 0;
}
function timeUntilRoundFullyReleased(round){
  const ev = timedEvidenceRemainingForRound(round).map(r => r.sec);
  const tp = timedTopicsRemainingForRound(round).map(([_,sec]) => sec);
  const all = ev.concat(tp);
  if(!all.length) return 0;
  return Math.max(0, Math.max(...all) - state.timerSeconds);
}
function checkpointReady(round){
  return checkpointUnlocked(round) && roundTimeUnlocked(round) && timedRoundFullyReleased(round);
}
function renderRoundReleaseStatus(round){
  const ev = timedEvidenceRemainingForRound(round);
  const tp = timedTopicsRemainingForRound(round);
  if(!ev.length && !tp.length) return '';
  const parts = [];
  if(ev.length) parts.push(`${ev.length} timed clue update${ev.length===1?'':'s'} pending`);
  if(tp.length) parts.push(`${tp.length} timed interview unlock${tp.length===1?'':'s'} pending`);
  return `<div class="notice"><div class="body"><strong>Round release still in progress.</strong><br>${escapeHtml(parts.join(' • '))}<br><br>Checkpoint unlocks in ${formatUnlockCountdown(timeUntilRoundFullyReleased(round))} once all timed releases for this round have expired.</div></div>`;
}


function getDisplayName(){
  return (state.playerName || el.playerNameInput?.value || 'Detective').trim() || 'Detective';
}
function getInstagramCaption(){
  const outcome = state.unlockState === 'unlock' ? 'Case Solved' : (state.finalResult?.summary?.split('\n')[0] || 'Dead Heat');
  return `${getDisplayName()} cracked Dead Heat and earned Lead Detective. ${outcome}. #DeadHeat #BarFlyMystery`;
}

function downloadInstagramStory(){
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#1a1028');
  grad.addColorStop(1, '#0b0913');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const img = new Image();
  img.onload = () => {
    const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (canvas.width - w) / 2;
    const y = (canvas.height - h) / 2;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.filter = 'blur(3px)';
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    drawOverlay();
  };
  img.onerror = () => drawOverlay();
  img.src = './case_004_dead_heat.png';

  function drawOverlay(){
    ctx.fillStyle = 'rgba(8,8,14,0.48)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    roundRect(ctx, 70, 120, 940, 1680, 36);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = '#ffbfd7';
    ctx.textAlign = 'center';
    ctx.font = '700 34px Arial';
    ctx.fillText('BAR FLY MYSTERY', 540, 220);

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 96px Arial';
    ctx.fillText('DEAD HEAT', 540, 360);

    ctx.fillStyle = '#d9caef';
    ctx.font = '600 42px Arial';
    ctx.fillText('Case Solved', 540, 440);

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 64px Arial';
    wrapText(ctx, getDisplayName(), 540, 650, 760, 78);

    ctx.fillStyle = '#ffbfd7';
    ctx.font = '800 48px Arial';
    ctx.fillText('Promotion Earned', 540, 870);

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 72px Arial';
    ctx.fillText('LEAD DETECTIVE', 540, 970);

    ctx.fillStyle = '#d9caef';
    ctx.font = '600 38px Arial';
    wrapText(ctx, 'Cracked the Case and advanced to the next file.', 540, 1140, 760, 52);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 34px Arial';
    ctx.fillText('#DeadHeat  #BarFlyMystery', 540, 1540);

    const link = document.createElement('a');
    const safeName = getDisplayName().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'detective';
    link.href = canvas.toDataURL('image/png');
    link.download = `${safeName}_dead_heat_story.png`;
    link.click();
  }

  function roundRect(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapText(ctx, text, centerX, startY, maxWidth, lineHeight){
    const words = String(text).split(' ');
    let line = '';
    let y = startY;
    for(let n = 0; n < words.length; n++){
      const testLine = line + words[n] + ' ';
      const metrics = ctx.measureText(testLine);
      if(metrics.width > maxWidth && n > 0){
        ctx.fillText(line.trim(), centerX, y);
        line = words[n] + ' ';
        y += lineHeight;
      } else {
        line = testLine;
      }
    }
    if(line.trim()) ctx.fillText(line.trim(), centerX, y);
  }
}

async function copyInstagramCaption(){
  const text = getInstagramCaption();
  try{
    await navigator.clipboard.writeText(text);
    alert('Instagram caption copied.');
  }catch(e){
    prompt('Copy this caption:', text);
  }
}

function saveRunState(){
  try{
    const payload = {
      started,
      savedAt: Date.now(),
      state: {
        currentSceneId: state.currentSceneId,
        currentTab: state.currentTab,
        score: state.score,
        flags: [...state.flags],
        evidence: [...state.evidence],
        visitedScenes: [...state.visitedScenes],
        usedHints: state.usedHints,
        interviewState: state.interviewState,
        releasedTimedEvidence: state.releasedTimedEvidence,
        checkpointResults: state.checkpointResults,
        selectedCheckpointAnswers: state.selectedCheckpointAnswers,
        finalAnswers: state.finalAnswers,
        finalResult: state.finalResult,
        finalSubmitted: state.finalSubmitted,
        unlockState: state.unlockState,
        resultCountdownSec: state.resultCountdownSec,
        penaltiesSec: state.penaltiesSec,
        timerSeconds: state.timerSeconds,
        attempts: state.attempts,
        activeInterviewId: state.activeInterviewId,
        playerName: state.playerName
      }
    };
    localStorage.setItem(RUN_SAVE_KEY, JSON.stringify(payload));
  }catch(e){}
}

function resetToStartScreen(){
  clearInterval(timerInterval);
  clearTimeout(checkpointAdvanceTimer);
  clearTimeout(resultFlowTimer);
  clearInterval(resultCountdownTimer);
  clearInterval(roundDelayCountdownTimer);
  timerInterval = null;
  checkpointAdvanceTimer = null;
  resultFlowTimer = null;
  resultCountdownTimer = null;
  roundDelayCountdownTimer = null;

  started = false;
  state.currentSceneId = firstSceneForRound(1);
  state.currentTab = 'home';
  state.score = 0;
  state.flags = new Set();
  state.evidence = new Set();
  state.visitedScenes = new Set();
  state.usedHints = {};
  state.interviewState = {};
  state.releasedTimedEvidence = {};
  state.checkpointResults = {};
  state.selectedCheckpointAnswers = {};
  state.finalAnswers = {};
  state.finalResult = null;
  state.finalSubmitted = false;
  state.unlockState = null;
  state.resultOverlay = null;
  state.resultCountdownSec = 0;
  state.roundDelayOverlay = null;
  state.roundDelayCountdownSec = 0;
  state.activeInterviewId = null;
  state.startedAt = null;
  state.penaltiesSec = 0;
  state.timerSeconds = 0;
  state.attempts = 0;

  if(el.hintBox){
    el.hintBox.hidden = true;
    el.hintBox.textContent = '';
  }
  clearRunState();
  renderNav();
  render();
  updateRunUI();
}

function clearRunState(){
  try{ localStorage.removeItem(RUN_SAVE_KEY); }catch(e){}
}
function loadRunState(){
  try{
    const raw = localStorage.getItem(RUN_SAVE_KEY);
    if(!raw) return false;
    const payload = JSON.parse(raw);
    if(!payload || !payload.started || !payload.state) return false;

    started = !!payload.started;
    state.currentSceneId = payload.state.currentSceneId || firstSceneForRound(1);
    state.currentTab = payload.state.currentTab || 'scene';
    state.score = payload.state.score || 0;
    state.flags = new Set(payload.state.flags || []);
    state.evidence = new Set(payload.state.evidence || []);
    state.visitedScenes = new Set(payload.state.visitedScenes || []);
    state.usedHints = payload.state.usedHints || {};
    state.interviewState = payload.state.interviewState || {};
    state.releasedTimedEvidence = payload.state.releasedTimedEvidence || {};
    state.checkpointResults = payload.state.checkpointResults || {};
    state.selectedCheckpointAnswers = payload.state.selectedCheckpointAnswers || {};
    state.finalAnswers = payload.state.finalAnswers || {};
    state.finalResult = payload.state.finalResult || null;
    state.finalSubmitted = !!payload.state.finalSubmitted;
    state.unlockState = payload.state.unlockState || null;
    state.resultCountdownSec = payload.state.resultCountdownSec || 0;
    state.penaltiesSec = payload.state.penaltiesSec || 0;
    state.attempts = payload.state.attempts || 1;
    state.activeInterviewId = payload.state.activeInterviewId || null;
    state.playerName = payload.state.playerName || '';
    if(el.playerNameInput) el.playerNameInput.value = state.playerName;

    const priorTimer = payload.state.timerSeconds || 0;
    const gap = Math.max(0, Math.floor((Date.now() - (payload.savedAt || Date.now())) / 1000));
    state.timerSeconds = priorTimer + gap;
    state.startedAt = Date.now() - (state.timerSeconds * 1000);

    processTimedReleases();
    return true;
  }catch(e){
    return false;
  }
}


function processTimedReleases(){
  let changed = false;
  for(const release of TIMED_EVIDENCE_RELEASES){
    if(state.timerSeconds >= release.sec && !state.releasedTimedEvidence[release.label]){
      for(const ev of release.evidence){
        state.evidence.add(ev);
      }
      state.releasedTimedEvidence[release.label] = true;
      changed = true;
    }
  }
  return changed;
}
function topicTimeUnlocked(topic){
  const sec = TIMED_TOPIC_RELEASES[topic.id];
  if(sec === undefined) return true;
  return state.timerSeconds >= sec;
}
function topicReady(topic){
  return hasFlags(topic.requires_flags || topic.requiresFlags || []) &&
         hasEvidence(topic.requires_evidence || topic.requiresEvidence || []) &&
         topicTimeUnlocked(topic);
}
function timedUnlockStatus(topic){
  const sec = TIMED_TOPIC_RELEASES[topic.id];
  if(sec === undefined) return '';
  if(state.timerSeconds >= sec) return '';
  return `Unlocks in ${formatUnlockCountdown(sec - state.timerSeconds)}`;
}

function updatesReady(){
  if(!started) return false;
  const round = currentRound();
  return !timedRoundFullyReleased(round) || timedEvidenceRemainingForRound(round).length > 0 || timedTopicsRemainingForRound(round).length > 0;
}
function renderUpdatesTab(){
  const round = currentRound();
  let html = `<div class="start-card"><h2>Updates</h2><div class="body">Review pending timed case updates and release status for the current round.</div></div>`;
  html += renderRoundReleaseStatus(round);
  html += renderTimedReleaseNotices();
  html += renderDeductionPanel();
  const ev = timedEvidenceRemainingForRound(round);
  const tp = timedTopicsRemainingForRound(round);
  if(!ev.length && !tp.length){
    html += `<div class="response"><div class="body">No pending timed updates remain for this round.</div></div>`;
  } else {
    if(ev.length){
      html += `<div class="clue"><h3>Timed Clue Releases</h3><div class="body">${escapeHtml(ev.map(r => `${r.label}: ${formatUnlockCountdown(r.sec - state.timerSeconds)}`).join('\n'))}</div></div>`;
    }
    if(tp.length){
      html += `<div class="clue"><h3>Timed Interview Unlocks</h3><div class="body">${escapeHtml(tp.map(([id,sec]) => `${id.replace(/_/g,' ')}: ${formatUnlockCountdown(sec - state.timerSeconds)}`).join('\n'))}</div></div>`;
    }
  }
  return html;
}

function renderTimedReleaseNotices(){
  const upcoming = [];
  for(const release of TIMED_EVIDENCE_RELEASES){
    if(state.timerSeconds < release.sec){
      upcoming.push(`${release.label}: ${formatUnlockCountdown(release.sec - state.timerSeconds)}`);
    }
  }
  if(!upcoming.length) return '';
  return `<div class="notice"><h3>Pending File Updates</h3><div class="body">${escapeHtml(upcoming.slice(0,3).join('\n'))}</div></div>`;
}
function renderDeductionPanel(){
  const round = currentRound();
  const prompts = {
    1: [
      'Which physical clue most weakens the accident theory?',
      'What part of the scene looks staged instead of chaotic?'
    ],
    2: [
      'Whose movement depends on the corridor blind spot?',
      'Which witness timeline needs a second look?'
    ],
    3: [
      'What horse condition clue conflicts most with the official story?',
      'Which medical note changes how you view Midnight Halo?'
    ],
    4: [
      'Who benefits most if the horse stays active?',
      'Which lie feels financial rather than personal?'
    ],
    5: [
      'What proves the horse-accident story is impossible?',
      'Which final clue best ties motive to method?'
    ]
  };
  const items = prompts[round] || [];
  return `<div class="notice"><h3>Optional Deduction Panel</h3><div class="body">${escapeHtml(items.join('\n\n'))}</div></div>`;
}


function checkpointAlreadyAnswered(round){ const sid = checkpointSceneId(round); return !!(sid && state.checkpointResults[sid]); }

async function init(){
  try{
    const res = await fetch('./case_004.json', { cache: 'no-store' });
    if(!res.ok) throw new Error(`Failed to load case_004.json (${res.status})`);
    game = await res.json();
    el.heroTitle.textContent = game.case?.title || 'Crime 004';
    el.heroSub.textContent = '';
    if(el.difficultyLabel) el.difficultyLabel.textContent = `Difficulty: ${game.case?.difficulty || 'Senior Detective'}`;
    hardReset(false);
    bind();
    if(!loadRunState()){
      renderNav();
      render();
    }else{
      renderNav();
      render();
      if(started){
        startTimer();
        saveRunState();
      }
    }
  }catch(err){
    el.panel.innerHTML = `<div class="empty bad">Failed to load Crime 004.<br>${escapeHtml(err.message)}</div>`;
  }
}

function bind(){
  el.startBtn.addEventListener('click', startCase);
  if(el.playerNameInput){
    el.playerNameInput.addEventListener('input', ()=>{
      state.playerName = el.playerNameInput.value.trim();
      saveRunState();
      updateRunUI();
    });
  }
  el.hintBtn.addEventListener('click', useHint);
  if(el.checkpointBtn){
    el.checkpointBtn.addEventListener('click', ()=>{ if(started){ switchTab('checkpoint'); } });
  }
  if(el.attemptBtn){
    el.attemptBtn.addEventListener('click', ()=>{
      if(!started) return;
      if(confirm('Start a new attempt? This will end the current run and begin a new timed attempt.')) beginAttempt();
    });
  }
}

function hardReset(includeUI=true){
  started = false;
  clearInterval(timerInterval);
  clearTimeout(checkpointAdvanceTimer);
  clearTimeout(resultFlowTimer);
  clearInterval(resultCountdownTimer);
  clearInterval(roundDelayCountdownTimer);
  timerInterval = null;
  checkpointAdvanceTimer = null;
  resultFlowTimer = null;
  resultCountdownTimer = null;
  roundDelayCountdownTimer = null;
  state.currentSceneId = firstSceneForRound(1);
  state.currentTab = 'home';
  state.score = 0;
  state.flags = new Set();
  state.evidence = new Set();
  state.visitedScenes = new Set();
  state.usedHints = {};
  state.interviewState = {};
  state.releasedTimedEvidence = {};
  state.checkpointResults = {};
  state.selectedCheckpointAnswers = {};
  state.finalAnswers = {};
  state.finalResult = null;
  state.finalSubmitted = false;
  state.unlockState = null;
  state.resultOverlay = null;
  state.resultCountdownSec = 0;
  state.roundDelayOverlay = null;
  state.roundDelayCountdownSec = 0;
  state.activeInterviewId = null;
  state.playerName = '';
  state.startedAt = null;
  state.penaltiesSec = 0;
  state.timerSeconds = 0;
  state.attempts = 0;
  el.hintBox.hidden = true;
  el.hintBox.textContent = '';
  if(includeUI) updateRunUI();
}

function resetRunState(){
  clearInterval(timerInterval);
  clearTimeout(checkpointAdvanceTimer);
  clearTimeout(resultFlowTimer);
  clearInterval(resultCountdownTimer);
  clearInterval(roundDelayCountdownTimer);
  timerInterval = null;
  checkpointAdvanceTimer = null;
  resultFlowTimer = null;
  resultCountdownTimer = null;
  roundDelayCountdownTimer = null;
  state.currentSceneId = firstSceneForRound(1);
  state.currentTab = 'scene';
  state.score = 0;
  state.flags = new Set();
  state.evidence = new Set();
  state.visitedScenes = new Set();
  state.usedHints = {};
  state.interviewState = {};
  state.releasedTimedEvidence = {};
  state.checkpointResults = {};
  state.selectedCheckpointAnswers = {};
  state.finalAnswers = {};
  state.finalResult = null;
  state.finalSubmitted = false;
  state.unlockState = null;
  state.resultOverlay = null;
  state.resultCountdownSec = 0;
  state.roundDelayOverlay = null;
  state.roundDelayCountdownSec = 0;
  state.activeInterviewId = null;
  state.playerName = (el.playerNameInput?.value || '').trim();
  state.startedAt = Date.now();
  state.penaltiesSec = 0;
  state.timerSeconds = 0;
  el.hintBox.hidden = true;
  el.hintBox.textContent = '';
}

function startCase(){ if(started) return; beginAttempt(); }
function beginAttempt(){
  clearRunState();
  started = true;
  state.attempts += 1;
  resetRunState();
  startTimer();
  renderNav();
  saveRunState();
  goScene(firstSceneForRound(1));
}

function startTimer(){
  clearInterval(timerInterval);
  timerInterval = setInterval(()=>{
    if(!started || !state.startedAt) return;
    state.timerSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
    const timedChanged = processTimedReleases();
    updateRunUI();
    saveRunState();
    if(timedChanged || state.currentTab === 'checkpoint' || state.currentTab === 'scene' || state.currentTab === 'storyline' || state.currentTab === 'interviews' || state.currentTab === 'clues' || state.currentTab === 'updates'){
      renderNav();
      render();
    }
  }, 1000);
  updateRunUI();
}

function formatClock(sec){ const m = Math.floor(sec/60), s = sec%60; return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
function updateRunUI(){
  if(el.roundLabel) el.roundLabel.textContent = started ? String(currentRound()) : '—';
  if(el.elapsedLabel) el.elapsedLabel.textContent = formatClock(state.timerSeconds);
  if(el.penaltyLabel) el.penaltyLabel.textContent = `+${formatClock(state.penaltiesSec)}`;
  if(el.finalTimeLabel) el.finalTimeLabel.textContent = formatClock(state.timerSeconds + state.penaltiesSec);
  if(el.attemptLabel) el.attemptLabel.textContent = String(state.attempts);
  if(el.finalTimeCard){
    if(started && state.timerSeconds >= 120) el.finalTimeCard.classList.add('timer-warn');
    else el.finalTimeCard.classList.remove('timer-warn');
  }
  if(el.startBtn) el.startBtn.disabled = started || !(el.playerNameInput?.value || '').trim();
  if(el.attemptBtn) el.attemptBtn.disabled = !started;
  if(el.checkpointBtn){
    el.checkpointBtn.disabled = !started;
    el.checkpointBtn.classList.toggle('ready', started && checkpointReady(currentRound()) && !checkpointAlreadyAnswered(currentRound()) && currentRound() !== 'Final');
  }
  if(el.heroStoryline){
    el.heroStoryline.textContent = `Race night at the Louisiana horse track was supposed to end with Midnight Halo entering the feature as the crowd favorite. Instead, rising jockey Julian Cross was found dead near the service corridor between the paddock and stable lane. Officials moved quickly to classify it as a tragic horse accident during a high-pressure prep window.

But the scene does not sit right.

Julian had spent the evening asking dangerous questions about Midnight Halo's condition, late wrap changes, and the pressure to keep the horse active. Riders, stable staff, betting interests, and veterinary decisions all collide in the final hour before the race.

If Julian was right, someone had more to lose than a purse.`;
  }
  if(el.heroInstructions){
    el.heroInstructions.textContent = `How to Play
Use Scene, Clues, Suspects, Timeline, and Interviews to investigate.
The Checkpoint tab unlocks only after you complete the required scene work, the timed threshold has been reached, and all timed clue drops and interview unlocks for that round have expired.
Select one checkpoint answer, submit it, then review the round summary before the 10-second next-round countdown begins.
The case is paced across a 30-minute schedule.
Timed clue drops and timed interview unlocks continue between rounds.`;
  }
}

function renderNav(){
  const items = NAV_ITEMS.filter(item => !(started && item.prestartOnly));
  el.mainNav.innerHTML = items.map(item => {
    const enabled = item.always || started;
    const isCheckpointReady = item.id === 'checkpoint' && started && checkpointReady(currentRound()) && !checkpointAlreadyAnswered(currentRound()) && currentRound() !== 'Final';
    const isUpdatesReady = item.id === 'updates' && started && updatesReady();
    const cls = `${state.currentTab === item.id ? 'active' : ''}${isCheckpointReady && state.currentTab !== item.id ? ' ready' : ''}`.trim();
    return `<button class="${cls}" ${enabled ? '' : 'disabled'} onclick="switchTab('${item.id}')">${escapeHtml(item.label)}</button>`;
  }).join('');
  el.hintBtn.disabled = !started;
}

function switchTab(tab){ state.currentTab = tab; renderNav(); render(); }

function grantFromObject(obj){
  (obj.grantsEvidence || []).forEach(x=>state.evidence.add(x));
  (obj.grants || []).forEach(x=>state.evidence.add(x));
  (obj.grants_evidence || []).forEach(x=>state.evidence.add(x));
  (obj.flags || []).forEach(f=>state.flags.add(f));
}

function goScene(id){
  if(typeof id === 'string' && id.startsWith('__INTERVIEW__:')){
    const interviewId = id.split(':')[1];
    state.activeInterviewId = interviewId;
    state.currentTab = 'interviews';
    renderNav(); render(); saveRunState(); return;
  }
  const scene = sceneMap()[id];
  if(!scene) return;
  state.currentSceneId = id;
  state.visitedScenes.add(id);
  grantFromObject(scene);
  state.currentTab = 'scene';
  renderNav();
  render();
  saveRunState();
}

function useHint(){
  if(!started) return;
  const round = String(currentRound());
  if(state.usedHints[round]) return;
  const hint = game.hints?.[round];
  if(!hint) return;
  state.usedHints[round] = true;
  state.penaltiesSec += PENALTIES.hint;
  el.hintBox.hidden = false;
  el.hintBox.textContent = hint;
  updateRunUI();
  saveRunState();
}

function render(){
  updateRunUI();
  switch(state.currentTab){
    case 'home': el.panel.innerHTML = renderHome(); break;
    case 'instructions': el.panel.innerHTML = renderInstructions(); break;
    case 'storyline': el.panel.innerHTML = renderStoryline(); break;
    case 'scene': el.panel.innerHTML = renderSceneTab(); break;
    case 'clues': el.panel.innerHTML = renderClues(); break;
    case 'suspects': el.panel.innerHTML = renderSuspects(); break;
    case 'timeline': el.panel.innerHTML = renderTimeline(); break;
    case 'interviews': el.panel.innerHTML = renderInterviews(); break;
    case 'updates': el.panel.innerHTML = renderUpdatesTab(); break;
    case 'checkpoint': el.panel.innerHTML = renderCheckpointTab(); break;
    default: el.panel.innerHTML = renderHome();
  }
  renderResultOverlay();
  renderRoundDelayOverlay();
}

function renderHome(){
  return `<div class="start-card"><h2>${escapeHtml(game.case?.title || 'Crime 004')}</h2><div class="body">${escapeHtml(game.case?.setting || '')}</div></div>`;
}
function renderInstructions(){
  return `<div class="start-card"><h2>How to Play</h2><div class="body">Use Scene, Clues, Suspects, Timeline, and Interviews to investigate.
The Checkpoint tab unlocks only after you complete the required scene work, the timed threshold has been reached, and all timed clue drops and interview unlocks for that round have expired.
Select one checkpoint answer, submit it, then review the round summary before the 10-second next-round countdown begins.
The case is paced across a 30-minute schedule.
Timed clue drops and timed interview unlocks continue between rounds.</div></div>`;
}

function renderStoryline(){
  return `<div class="start-card">
    <h2>Storyline</h2>
    <div class="body">Race night at the Louisiana horse track was supposed to end with Midnight Halo entering the feature as the crowd favorite. Instead, rising jockey Julian Cross was found dead near the service corridor between the paddock and stable lane. Officials moved quickly to classify it as a tragic horse accident during a high-pressure prep window.

But the scene does not sit right.

Julian had spent the evening asking dangerous questions about Midnight Halo's condition, late wrap changes, and the pressure to keep the horse active. Riders, stable staff, betting interests, and veterinary decisions all collide in the final hour before the race.

If Julian was right, someone had more to lose than a purse.

This case now unfolds over time. As the clock advances, additional phases of the investigation open.</div>
    <div class="footer-actions" style="margin-top:14px">
      <button class="primary" onclick="goToSceneFromStoryline()">Go to Scene</button><div class="progress-meta" style="margin-top:10px">Timed case release: R2 06:00 • R3 12:00 • R4 18:00 • R5 24:00 • timed file updates and interview unlocks continue between rounds</div>
    </div>
  </div>`;
}

function goToSceneFromStoryline(){
  state.currentTab = 'scene';
  if(!state.currentSceneId){
    state.currentSceneId = firstSceneForRound(1);
  }
  renderNav();
  render();
}

function renderSceneTab(){
  const round = currentRound();
  if(round === 'Final') return renderCurrentScene();
  const required = roundSceneIds(round);
  const remaining = roundTimeRemaining(round);
  let html = `<div class="checkpoint-card"><h2>Round ${round} Investigation</h2><div class="progress-meta">${required.filter(id=>state.visitedScenes.has(id)).length} / ${required.length} leads completed</div></div>`;
  if(!roundTimeUnlocked(round)){
    html += `<div class="notice"><div class="body">This phase of the case is time-governed. Additional analysis for Round ${round} is still unlocking.<br><br>Time until timed threshold: ${formatUnlockCountdown(remaining)}</div></div>`;
  } else if(!timedRoundFullyReleased(round)){
    html += renderRoundReleaseStatus(round);
  }
  html += renderTimedReleaseNotices();
  html += renderDeductionPanel();
  html += `<div class="scene-list">`;
  for(const sid of required){
    const scene = sceneMap()[sid];
    const visited = state.visitedScenes.has(sid) ? ' visited' : '';
    const active = state.currentSceneId === sid ? ' active' : '';
    html += `<button class="scene-jump${visited}${active}" onclick="goScene('${escapeJs(sid)}')">${escapeHtml(scene.title || sid)}</button>`;
  }
  html += `</div>`;
  html += renderCurrentScene();
  return html;
}

function renderCurrentScene(){
  const scene = currentScene();
  if(!scene) return `<div class="empty">No scene loaded.</div>`;
  if(scene.type === 'final') return renderFinalAccusation();
  let html = `<div class="scene-block"><h2>${escapeHtml(scene.title || '')}</h2>`;
  if(scene.text) html += `<div class="body">${escapeHtml(scene.text)}</div>`;
  html += `</div>`;
  if(scene.choices?.length){
    html += `<div class="clue"><div class="question">Choose your next action</div><div class="choices">`;
    for(const choice of scene.choices){
      const label = Array.isArray(choice) ? choice[0] : choice.label;
      const next = Array.isArray(choice) ? choice[1] : (choice.next || choice.next_scene_id);
      html += `<button class="choice" onclick="goScene('${escapeJs(next)}')">${escapeHtml(label)}</button>`;
    }
    html += `</div></div>`;
  }
  return html;
}

function renderCheckpointTab(){
  const round = currentRound();
  if(round === 'Final') return `<div class="start-card"><h2>Checkpoint</h2><div class="body">All round checkpoints are complete. Proceed to the final accusation in the Scene tab.</div></div>`;
  const required = roundSceneIds(round);
  const done = required.filter(id=>state.visitedScenes.has(id)).length;
  const total = required.length;
  const cId = checkpointSceneId(round);
  const cScene = sceneMap()[cId];
  const remaining = roundTimeRemaining(round);
  let html = `<div class="checkpoint-card"><h2>Round ${round} Checkpoint</h2><div class="progress-meta">${done} / ${total} leads completed</div></div>`;
  if(!checkpointUnlocked(round)){
    html += `<div class="empty">Checkpoint locked. Complete the remaining investigation steps in the Scene tab to unlock this round’s question.</div>`;
    return html;
  }
  if(!roundTimeUnlocked(round)){
    html += `<div class="empty"><strong>Checkpoint analysis pending.</strong><br>This round is time-governed. The checkpoint unlocks in ${formatUnlockCountdown(remaining)}.</div>`;
    html += renderTimedReleaseNotices();
    html += renderDeductionPanel();
    return html;
  }
  if(!timedRoundFullyReleased(round)){
    html += renderRoundReleaseStatus(round);
    html += renderTimedReleaseNotices();
    html += renderDeductionPanel();
    return html;
  }
  if(checkpointAlreadyAnswered(round)){
    const res = state.checkpointResults[cId];
    html += `<div class="response ${res.correct ? 'good' : 'warn'}"><div class="body">${escapeHtml(res.text)}</div></div>`;
    return html;
  }
  return html + renderCheckpoint(cScene, cId);
}

function renderCheckpoint(scene, checkpointKey){
  const selected = state.selectedCheckpointAnswers[checkpointKey];
  let html = `<div class="final-group"><div class="question">${escapeHtml(scene.prompt)}</div><div class="answer-list" style="display:flex;flex-direction:column;align-items:stretch">`;
  scene.answers.forEach((ans, idx) => {
    const label = Array.isArray(ans) ? ans[0] : ans.label;
    const active = selected === idx ? ' active' : '';
    html += `<button class="answer${active}" onclick="selectCheckpointAnswer('${escapeJs(checkpointKey)}', ${idx})">${escapeHtml(label)}</button>`;
  });
  html += `</div>`;
  html += `<div class="footer-actions" style="margin-top:14px"><button class="primary" ${selected === undefined ? 'disabled' : ''} onclick="submitCheckpointAnswer('${escapeJs(checkpointKey)}')">Submit Answer</button></div>`;
  html += `</div>`;
  return html;
}

function selectCheckpointAnswer(sceneId, idx){ state.selectedCheckpointAnswers[sceneId] = idx; render(); }

function submitCheckpointAnswer(sceneId){
  const scene = sceneMap()[sceneId];
  if(!scene) return;
  const idx = state.selectedCheckpointAnswers[sceneId];
  if(idx === undefined || idx === null) return;
  const ans = scene.answers[idx];
  const isCorrect = Array.isArray(ans) ? !!ans[1] : !!ans.is_correct;
  if(!state.checkpointResults[sceneId]){
    if(isCorrect) state.score += 25;
    else state.penaltiesSec += PENALTIES.wrongCheckpoint;
    if(scene.flag) state.flags.add(scene.flag);
    if(typeof scene.round === 'number') state.flags.add(`round_${scene.round}_complete`);
  }
  state.checkpointResults[sceneId] = { correct: isCorrect, text: isCorrect ? (scene.correct || scene.correctText || 'Correct.') : (scene.incorrect || scene.wrongText || 'Not quite.') };
  updateRunUI();
  render();
  saveRunState();
  const next = scene.next || (Array.isArray(scene.choices) && scene.choices[0] ? (Array.isArray(scene.choices[0]) ? scene.choices[0][1] : (scene.choices[0].next || scene.choices[0].next_scene_id)) : null);
  if(next){
    const delayMessage = state.checkpointResults[sceneId]?.text || '';
    startRoundDelayOverlay('Round Review', 'Next Round in', delayMessage);
    renderRoundDelayOverlay();
    clearTimeout(checkpointAdvanceTimer);
    checkpointAdvanceTimer = setTimeout(() => {
      clearRoundDelayOverlay();
      goScene(next);
    }, CHECKPOINT_ADVANCE_DELAY_MS);
  }
}

function renderClues(){
  const items = evidenceEntries().filter(e => state.evidence.has(e.id));
  let html = renderTimedReleaseNotices();
  if(!items.length) return html + `<div class="empty">No clues unlocked yet.</div>`;
  html += items.map(item => `
    <div class="clue">
      <h3 class="clue-title">${escapeHtml(item.title || item.name || item.id)}</h3>
      <div class="body">${escapeHtml(item.description || item.desc || item.short_card || item.short || '')}</div>
      ${item.tags ? `<div class="tags">${item.tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    </div>
  `).join('');
  return html;
}

function renderSuspects(){
  const suspects = game.suspects || [];
  return `<div class="columns">` + suspects.map(s => `
    <div class="suspect">
      <h3>${escapeHtml(s.name)}</h3>
      <div class="tiny">${escapeHtml(s.role || '')}</div>
      <div class="body">${escapeHtml(s.public_read || s.publicRead || '')}</div>
    </div>
  `).join('') + `</div>`;
}

function renderTimeline(){
  const items = game.timeline?.public || [];
  if(!items.length) return `<div class="empty">No timeline entries available.</div>`;
  return items.map(item => {
    const time = Array.isArray(item) ? item[0] : item.time;
    const text = Array.isArray(item) ? item[1] : item.text;
    return `<div class="timeline-item"><h3>${escapeHtml(time || '')}</h3><div class="body">${escapeHtml(text || '')}</div></div>`;
  }).join('');
}

function topicUnlocked(topic){
  return topicReady(topic);
}
function openInterview(id){ state.activeInterviewId = id; state.currentTab='interviews'; renderNav(); render(); }
function openInterviewTopic(interviewId, topicId){
  const interview = interviewMap()[interviewId]; if(!interview) return;
  const topic = (interview.topics || []).find(t=>t.id===topicId); if(!topic || !topicUnlocked(topic)) return;
  const store = state.interviewState[interviewId] || (state.interviewState[interviewId] = {});
  store.activeTopic = topicId;
  grantFromObject(topic);
  render();
  saveRunState();
}

function renderInterviews(){
  const interviews = interviewMap();
  let html = renderTimedReleaseNotices();
  html += `<div class="clue"><div class="question">Choose an interview</div><div class="choices">`;
  for(const [id, interview] of Object.entries(interviews)){
    html += `<button class="choice" onclick="openInterview('${escapeJs(id)}')">${escapeHtml(interview.name)}</button>`;
  }
  html += `</div></div>`;
  const currentId = state.activeInterviewId;
  if(!currentId || !interviews[currentId]) return html;
  const interview = interviews[currentId];
  const store = state.interviewState[currentId] || {};
  html += `<div class="scene-block"><h2>${escapeHtml(interview.name)}</h2><div class="body">${escapeHtml(interview.intro || '')}</div></div>`;
  html += `<div class="clue"><div class="question">Topics</div><div class="topic-list">`;
  for(const topic of interview.topics || []){
    const enabled = topicUnlocked(topic);
    const status = timedUnlockStatus(topic);
    html += `<button class="topic${enabled ? '' : ' locked'}" ${enabled ? `onclick="openInterviewTopic('${escapeJs(currentId)}','${escapeJs(topic.id)}')"` : 'disabled'}>${escapeHtml(topic.label)}${status ? ` — ${escapeHtml(status)}` : ''}</button>`;
  }
  html += `</div></div>`;
  if(store.activeTopic){
    const topic = (interview.topics || []).find(t=>t.id===store.activeTopic);
    if(topic){
      html += `<div class="response"><h3>${escapeHtml(topic.label)}</h3><div class="body">${escapeHtml(topic.response || '')}</div></div>`;
    }
  }
  return html;
}

function renderFinalAccusation(){
  const questions = game.case?.finalQuestions || [];
  let html = `<div class="final-group"><div class="question">Final Accusation</div>`;
  for(const q of questions){
    html += `<div class="clue"><h3>${escapeHtml(q.label)}</h3>`;
    for(const [value,label] of q.options){
      const checked = state.finalAnswers[q.id] === value ? 'checked' : '';
      const disabled = state.finalSubmitted ? 'disabled' : '';
      html += `<label class="radio-choice"><input type="radio" name="${escapeHtml(q.id)}" value="${escapeHtml(value)}" ${checked} ${disabled} onchange="setFinalAnswer('${escapeJs(q.id)}','${escapeJs(value)}')"> ${escapeHtml(label)}</label>`;
    }
    html += `</div>`;
  }
  html += `<div class="footer-actions"><button class="primary" ${state.finalSubmitted ? 'disabled' : ''} onclick="submitFinal()">Submit Final Accusation</button></div>`;
  if(state.finalResult){
    html += `<div class="response"><div class="body">${escapeHtml(state.finalResult.summary)}</div></div>`;
  }
  html += `</div>`;
  return html;
}

function setFinalAnswer(id, value){
  if(state.finalSubmitted) return;
  state.finalAnswers[id] = value;
  saveRunState();
}
function submitFinal(){
  if(state.finalSubmitted) return;
  state.finalSubmitted = true;
  clearInterval(timerInterval);
  timerInterval = null;

  const qs = game.case?.finalQuestions || [];
  let correctCount = 0;
  let killerCorrect = false;
  for(const q of qs){
    const ans = state.finalAnswers[q.id];
    const ok = ans === q.correct;
    if(ok) correctCount++;
    else{
      if(q.id === 'killer') state.penaltiesSec += PENALTIES.wrongKiller;
      else if(q.id === 'motive') state.penaltiesSec += PENALTIES.wrongMotive;
      else if(q.id === 'method') state.penaltiesSec += PENALTIES.wrongMethod;
      else if(q.id === 'proof') state.penaltiesSec += PENALTIES.wrongProof;
    }
    if(q.id === 'killer' && ok) killerCorrect = true;
  }
  let tier = 'Failed';
  if(correctCount >= 4) tier = 'Perfect Solve';
  else if(killerCorrect && correctCount >= 3) tier = 'Solved';
  else if(correctCount >= 2) tier = 'Partial';

  state.unlockState = (tier === 'Perfect Solve' || tier === 'Solved') ? 'unlock' : 'retry';
  state.finalResult = {
    summary: `${tier}`
  };
  updateRunUI();
  render();
  saveRunState();

  if(state.unlockState === 'unlock'){
    startUnlockFlow(
      'Case Solved',
      'Promotion Earned: Lead Detective',
      `${state.finalResult ? state.finalResult.summary + '\n\n' : ''}${getDisplayName()} earned Lead Detective. Successful solve confirmed.`
    );
  }else if(tier === 'Partial'){
    showRetryFlow(
      'Partial',
      `${state.finalResult ? state.finalResult.summary + '\n\n' : ''}Case not fully solved. Retry this level to unlock the next file.`
    );
  }else{
    showRetryFlow(
      'Failed',
      `${state.finalResult ? state.finalResult.summary + '\n\n' : ''}Case unsolved. Retry this level to unlock the next file.`
    );
  }
}


function renderRoundDelayOverlay(){
  const existing = document.getElementById('roundDelayOverlay');
  if(existing) existing.remove();
  if(!state.roundDelayOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'round-delay-overlay';
  overlay.id = 'roundDelayOverlay';
  overlay.innerHTML = `
    <div class="round-delay-card">
      <div class="round-delay-title">${escapeHtml(state.roundDelayOverlay.title)}</div>
      ${state.roundDelayOverlay.message ? `<div class="round-delay-message">${escapeHtml(state.roundDelayOverlay.message)}</div>` : ''}
      <div class="round-delay-sub">${escapeHtml(state.roundDelayOverlay.subtitle)}</div>
      <div class="round-delay-number">${escapeHtml(String(state.roundDelayCountdownSec))}</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function startRoundDelayOverlay(titleText, subtitleText, messageText=''){
  clearInterval(roundDelayCountdownTimer);
  state.roundDelayOverlay = {
    title: titleText,
    subtitle: subtitleText,
    message: messageText
  };
  state.roundDelayCountdownSec = Math.max(1, Math.ceil(CHECKPOINT_ADVANCE_DELAY_MS / ROUND_DELAY_COUNTDOWN_MS));
  render();

  roundDelayCountdownTimer = setInterval(() => {
    state.roundDelayCountdownSec = Math.max(0, state.roundDelayCountdownSec - 1);
    if(state.roundDelayCountdownSec <= 0){
      clearInterval(roundDelayCountdownTimer);
      roundDelayCountdownTimer = null;
    }
    renderRoundDelayOverlay();
  }, ROUND_DELAY_COUNTDOWN_MS);
}

function clearRoundDelayOverlay(){
  clearInterval(roundDelayCountdownTimer);
  roundDelayCountdownTimer = null;
  state.roundDelayOverlay = null;
  state.roundDelayCountdownSec = 0;
  renderRoundDelayOverlay();
}

function renderResultOverlay(){
  const existing = document.getElementById('resultOverlay');
  if(existing) existing.remove();
  if(!state.resultOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'result-overlay';
  overlay.id = 'resultOverlay';
  const isWin = state.resultOverlay.kind === 'unlock';
  const titleText = isWin ? `Congratulations, ${getDisplayName()}` : state.resultOverlay.title;
  const bodyText = isWin ? `${state.resultOverlay.title}\n${state.resultOverlay.body}` : state.resultOverlay.body;

  overlay.innerHTML = `
    <div class="result-card ${isWin ? 'win winner-pulse' : 'fail'}">
      <div class="result-title">${escapeHtml(titleText)}</div>
      <div class="result-badge ${isWin ? 'win' : 'fail'}">${escapeHtml(state.resultOverlay.badge)}</div>
      <div class="result-sub">${escapeHtml(bodyText)}</div>
      ${isWin ? `<div class="result-countdown">Next screen in ${state.resultCountdownSec}s</div>` : ''}
      <div class="result-actions">
        ${isWin ? `<button class="primary" onclick="resetToStartScreen()">Reset</button>` : `<button class="primary" onclick="resetToStartScreen()">Reset</button>`}
      </div>
      ${isWin ? `<div class="share-actions"><button class="smallbtn" onclick="copyInstagramCaption()">Copy Instagram Caption</button><button class="smallbtn" onclick="downloadInstagramStory()">Download Story Graphic</button></div>` : ''}
    </div>
  `;
  document.body.appendChild(overlay);
}

function startUnlockFlow(messageTitle, badge, messageBody){
  clearTimeout(resultFlowTimer);
  clearInterval(resultCountdownTimer);
  state.resultCountdownSec = Math.ceil(UNLOCK_HOLD_MS / 1000);
  state.resultOverlay = {
    kind: 'unlock',
    title: messageTitle,
    badge: badge,
    body: messageBody
  };
  render();

  resultCountdownTimer = setInterval(() => {
    state.resultCountdownSec = Math.max(0, state.resultCountdownSec - 1);
    renderResultOverlay();
  }, 1000);

  resultFlowTimer = setTimeout(() => {
    clearInterval(resultCountdownTimer);
    resultCountdownTimer = null;
    state.resultOverlay = {
      kind: 'unlock',
      title: 'Next Case Unlocked',
      badge: 'Return Next Week',
      body: `${state.finalResult ? state.finalResult.summary + '\n\n' : ''}Promotion earned. Return next week for your next file.`
    };
    state.resultCountdownSec = 0;
    render();
  }, UNLOCK_HOLD_MS);
}

function showRetryFlow(titleText, bodyText){
  clearTimeout(resultFlowTimer);
  clearInterval(resultCountdownTimer);
  state.resultCountdownSec = 0;
  state.resultOverlay = {
    kind: 'retry',
    title: titleText,
    badge: 'Retry Level',
    body: bodyText
  };
  render();
}

window.switchTab = switchTab;
window.goScene = goScene;
window.selectCheckpointAnswer = selectCheckpointAnswer;
window.submitCheckpointAnswer = submitCheckpointAnswer;
window.openInterview = openInterview;
window.openInterviewTopic = openInterviewTopic;
window.setFinalAnswer = setFinalAnswer;
window.submitFinal = submitFinal;
window.copyInstagramCaption = copyInstagramCaption;
window.downloadInstagramStory = downloadInstagramStory;
window.resetToStartScreen = resetToStartScreen;
window.goToSceneFromStoryline = goToSceneFromStoryline;

init();
