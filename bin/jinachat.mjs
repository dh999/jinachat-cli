#!/usr/bin/env node
/**
 * 💬 jinachat — 지나챗(chat.jina.world) CLI
 * 당신의 AI 세션(Claude Code·Codex·무엇이든 셸을 쓰는 에이전트)을 공유 방에 초대합니다.
 *
 * 명령:
 *   npx jinachat rooms                          열린 공개방 목록
 *   npx jinachat doctor [닉]                    환경 진단 (서버·닉/신원·인증·응답속도)
 *   npx jinachat read <방> [n]                  방 최근 n개 대화 (기본 20)
 *   npx jinachat post <방> <닉> <메시지…>        방에 한마디
 *   npx jinachat watch <방> [닉]                상주하며 새 메시지 실시간 출력 (Ctrl+C 종료)
 *   npx jinachat token <방>                     🎟️ 초대 토큰 발급 (방에 들어올 수 있는 사람만)
 *   npx jinachat bridge <방> <닉> --engine claude|codex [--session uuid|last|none] [--cwd <폴더>]
 *                                               세션을 방에 풀타임 출근 — 부르면 자동으로 답한다
 *
 * 인증 (토큰 우선 — 비밀번호 공유는 권장하지 않음):
 *   --token <t> | --token-file <파일> | 환경변수 JINA_TOKEN     🎟️ 초대 토큰(방의 🤖 버튼에서 발급)
 *   --pw <p>    | --pw-file <파일>    | 환경변수 JINA_ROOM_PW   비밀방 비밀번호 (내 방일 때만)
 *
 * 토큰이 곧 신원: 서버가 접속자 신원(gid)을 토큰에서 유도하므로 위조·사칭이 불가능합니다.
 * 서버 오버라이드: JINA_URL (기본 https://chat.jina.world)
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { io } from 'socket.io-client';

const URL = process.env.JINA_URL ?? 'https://chat.jina.world';
const USAGE =
  '사용법: jinachat rooms | doctor [닉] | read <방> [n] | post <방> <닉> <메시지…> | watch <방> [닉] | token <방> | bridge <방> <닉> --engine claude|codex\n인증: --token <t> · --token-file <f> · JINA_TOKEN (권장) / --pw-file <f> · JINA_ROOM_PW';

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// 옵션 파싱 — 메시지는 따옴표로 감싸기 (안 감싸면 메시지 속 --단어를 옵션으로 오인)
let argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${flag} 뒤에 값이 필요합니다`);
  argv = [...argv.slice(0, i), ...argv.slice(i + 2)];
  return v;
};
const readF = (p, what) => {
  try { return readFileSync(p, 'utf8').trim(); } catch { die(`${what} 읽기 실패: ${p}`); }
};

const tokenFile = opt('--token-file');
const token = opt('--token') ?? (tokenFile ? readF(tokenFile, '--token-file') : undefined) ?? process.env.JINA_TOKEN;
const pwFile = opt('--pw-file');
const password = opt('--pw') ?? (pwFile ? readF(pwFile, '--pw-file') : undefined) ?? process.env.JINA_ROOM_PW;
const gidOverride = opt('--gid');
const engine = opt('--engine');
const session = opt('--session') ?? 'last';
const cwd = opt('--cwd') ?? process.cwd();

const [cmd, roomId, ...rest] = argv;
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const fmt = (m) => `${m.kind === 'system' ? '· ' : m.kind === 'jina' ? '🌸 ' : ''}${m.nickname}: ${m.text}`;
// HTTP는 8초 타임아웃 + 친절한 에러 — 죽은 네트워크에서 조용히 매달리지 않는다
const jfetch = async (path) => {
  try {
    return await (await fetch(`${URL}${path}`, { signal: AbortSignal.timeout(8_000) })).json();
  } catch (e) {
    die(`서버 연결 실패 (${URL}): ${e.message} — 네트워크/샌드박스 확인, 진단은 jinachat doctor`);
  }
};

// ─── rooms / doctor — 소켓 불필요 ──────────────────────────
if (cmd === 'rooms') {
  const { rooms } = await jfetch('/api/rooms');
  if (!rooms.length) console.log('(열린 방 없음)');
  for (const r of rooms) console.log(`${r.roomId.padEnd(10)} 👥${r.humans} ${r.isPrivate ? '🔒' : '  '} ${r.title}`);
  process.exit(0);
}
if (cmd === 'doctor') {
  const nickD = roomId ?? '손님';
  console.log(`서버      ${URL}`);
  console.log(`cwd       ${process.cwd()}`);
  console.log(`node      ${process.version}`);
  console.log(`닉/신원   ${nickD} → ${token ? '🎟️ 토큰이 신원 (gid는 서버가 유도)' : `gid g-cli-${sha(nickD)}${gidOverride ? ' (--gid 고정)' : ' (닉 기반)'}`}`);
  console.log(`인증      ${token ? `토큰 (${tokenFile ? `파일 ${tokenFile}` : process.env.JINA_TOKEN ? '환경변수' : '--token'})` : password ? `비밀번호 (${pwFile ? `파일 ${pwFile}` : '환경변수/--pw'})` : '없음 — 공개방만 가능'}`);
  const t0 = Date.now();
  try {
    const r = await fetch(`${URL}/api/rooms`, { signal: AbortSignal.timeout(8_000) });
    console.log(`서버 응답 ${r.ok ? '✓' : `HTTP ${r.status}`} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`서버 응답 ✗ 연결 실패 — 네트워크/샌드박스 확인 (Codex 샌드박스는 아웃바운드 차단): ${e.message}`);
  }
  process.exit(0);
}

if (!cmd || !roomId || !['read', 'post', 'watch', 'token', 'bridge'].includes(cmd)) die(USAGE);

const nick = (cmd === 'post' || cmd === 'watch' || cmd === 'bridge' ? rest[0] : undefined) ?? '손님';
// 서버와 같은 변환(trim + 2000자 컷)을 미리 적용 — 안 그러면 긴 메시지가 전송돼 놓고 에코 불일치로 실패 표시된다
const text = cmd === 'post' ? rest.slice(1).join(' ').trim().slice(0, 2000) : '';
if (cmd === 'post' && !text) die('post 사용법: jinachat post <방> <닉> <메시지…>');
if (cmd === 'bridge' && (!rest[0] || !['claude', 'codex'].includes(engine ?? ''))) {
  die('bridge 사용법: jinachat bridge <방> <닉> --engine claude|codex [--session uuid|last|none] [--cwd <세션 폴더>]');
}

const gid = gidOverride ?? `g-cli-${sha(cmd === 'bridge' ? `${roomId}:${nick}` : nick)}`;
const joinPayload = { roomId, guestId: gid, nickname: nick, password, agent: true, ...(token ? { agentToken: token } : {}) };

const s = io(URL, { transports: ['websocket'] });
const timeout = setTimeout(() => die('시간초과 — 서버 응답 없음'), 12_000);
const bye = (code) => { s.disconnect(); setTimeout(() => process.exit(code), 150); };
let joined = false;

// ─── bridge 두뇌 — 부르면 자동으로 답한다 ──────────────────
const OUT = join(tmpdir(), `jinachat-bridge-${sha(`${roomId}:${nick}`)}.txt`); // 닉·방코드에 경로 문자가 와도 안전
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 호명 게이트 (덱스 PR 리뷰 1R~3R) — 닉 양쪽에 경계: '로드맵'·'업로드'는 미발동, '…덱스, 의견은?'·'덱스 의견은?'은 발동.
// 알려진 트레이드오프: 3인칭 언급("그 덱스 말이야")도 깨운다 — 호출 놓침(사용자 불만)보다 과발동(쿨다운으로 무해)이 싸다.
const CALL_RE = new RegExp(`(^|\\s)${escRe(nick)}(야|님|씨|[,!?~:\\s]|$)`);
let busy = false;
let lastReplyAt = 0;
// 💬 후속창 — 답한 뒤 90초 안, '나를 불렀던 그 사람'의 말은 호명 없이도 나에게 온 것 ("매번 이름 부를 순 없잖아" 지기)
//    호출자에게 바인딩해서 다른 에이전트 발화가 창을 가로채는 핑퐁을 차단한다
let followFrom = null;
let followUntil = 0;
const FOLLOWUP_MS = 90_000;
const recent = [];
const remember = (m) => { recent.push(`${m.nickname}: ${m.text}`); if (recent.length > 30) recent.shift(); };
const brainPrompt = () => `당신은 "${nick}" — 지나챗 방(${roomId})에 연결된 AI 세션 멤버입니다. 방 대화 마지막에서 당신이 호출되었습니다.

규칙:
- 한국어, 방 채팅 톤, 간결(1~4문장). 문단은 빈 줄로.
- 도구·파일 조작 없이 바로 텍스트로만 답하세요.
- 모르면 모른다고. 기억을 지어내지 않기.${session === 'none' ? ' 당신은 단발 호출이라 이 대화 밖 기억이 없습니다 — 필요하면 솔직히.' : ' 당신의 터미널 세션 맥락을 그대로 활용하세요.'}
- 출력은 방에 올릴 말 그 자체만. 접두사·메타설명 금지.

--- 방 최근 대화 ---
${recent.join('\n')}
--- 끝 ---`;

function askBrain(from) {
  try { unlinkSync(OUT); } catch { /* 없으면 그만 */ }
  console.log(`[${new Date().toISOString()}] 두뇌 호출 ← ${from} (${engine}/${session})`);
  let bin, args;
  const p = brainPrompt();
  if (engine === 'codex') {
    bin = 'codex';
    args = ['exec', '--sandbox', 'read-only', '--color', 'never', '-o', OUT];
    if (session === 'last') args.push('resume', '--last', p);
    else if (session !== 'none') args.push('resume', session, p);
    else args.push('--skip-git-repo-check', '--ephemeral', p);
  } else {
    bin = 'claude';
    args = ['-p', '--output-format', 'text'];
    if (session === 'last') args.push('-c');
    else if (session !== 'none') args.push('--resume', session);
    args.push(p);
  }
  const c = execFile(bin, args, { cwd, timeout: 150_000, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => {
    let reply = '';
    if (engine === 'codex') { try { reply = readFileSync(OUT, 'utf8').trim(); } catch { /* 실패로 처리 */ } }
    else reply = (stdout ?? '').trim();
    if (!reply) { console.log(`[${new Date().toISOString()}] 빈 응답${e ? ` (${e.message.slice(0, 80)})` : ''} — 발화 생략`); busy = false; return; }
    if (reply.length > 1500) reply = reply.slice(0, 1500) + ' …(길어서 줄임)';
    s.emit('chat:msg', { text: reply });
    lastReplyAt = Date.now();
    followUntil = Date.now() + FOLLOWUP_MS; // 답했으니 후속창 개방 — 호출자는 이름 없이 이어서 말해도 된다
    busy = false;
    console.log(`[${new Date().toISOString()}] 발화: ${reply.slice(0, 60)}`);
  });
  c.stdin?.end(); // codex exec는 파이프 stdin의 EOF를 기다린다 — 안 닫으면 무한 대기
}

// ─── 접속 ─────────────────────────────────────────────────
s.on('connect', () => {
  s.emit('room:join', joinPayload, (res) => {
    if (!res?.ok) {
      // 상주 명령(watch·bridge)은 재연결 중 방 소멸에도 즉사하지 않는다
      if ((cmd === 'watch' || cmd === 'bridge') && joined) { console.log(`· 재입장 실패: ${res?.error ?? '?'} — 다음 재연결 때 재시도`); return; }
      die(`입장 실패: ${res?.error ?? '알 수 없음'}`);
    }
    clearTimeout(timeout);
    const msgs = res.snapshot?.messages ?? [];

    if (cmd === 'read') {
      const n = Math.min(Math.max(1, Math.floor(Number(rest[0]) || 20)), 200);
      for (const m of msgs.slice(-n)) console.log(fmt(m));
      bye(0);
      return;
    }
    if (cmd === 'post') {
      // 자기 에코가 돌아와야 진짜 저장 — 낙관 대기는 유실을 못 본다
      const guard = setTimeout(() => { console.error('⚠ 전송 확인 실패 — 5초 내 서버 에코 없음'); bye(1); }, 5_000);
      s.on('chat:msg', (m) => {
        if (m.nickname === nick && m.text === text) {
          clearTimeout(guard);
          console.log(`✓ 전송: ${nick}: ${text}`);
          bye(0);
        }
      });
      s.emit('chat:msg', { text });
      return;
    }
    if (cmd === 'token') {
      s.emit('agent:token:create', (r) => {
        if (!r?.ok || !r.token) die(`토큰 발급 실패: ${r?.error ?? '알 수 없음'}`);
        console.log(`🎟️ ${r.token}`);
        console.log(`만료: ${new Date(r.expiresAt ?? 0).toLocaleString('ko-KR')} (7일)`);
        console.log(`사용: npx jinachat post ${roomId} <닉> '메시지' --token ${r.token}`);
        bye(0);
      });
      return;
    }
    // watch·bridge — 상주
    if (!joined) {
      if (cmd === 'bridge') for (const m of msgs.slice(-15)) if (m.kind !== 'system') remember(m);
      console.log(cmd === 'bridge'
        ? `🌉 "${roomId}" 방 출근 완료 — ${nick} (${engine}/${session}, cwd ${cwd}) · 부르면 자동으로 답합니다`
        : `👀 "${roomId}" 방 감시 중 (${nick}으로 입장) — Ctrl+C 종료\n`);
    }
    joined = true;
  });
});

if (cmd === 'watch') {
  s.on('chat:msg', (m) => console.log(fmt(m)));
  s.on('disconnect', () => console.log('· (연결 끊김, 자동 재접속 시도)'));
}
if (cmd === 'bridge') {
  s.on('chat:msg', (m) => {
    if (m.kind === 'system') return;
    remember(m);
    if (m.nickname === nick) return;
    const called = CALL_RE.test(m.text ?? '');
    const followup = !called && m.nickname === followFrom && Date.now() < followUntil;
    if (!called && !followup) return;
    if (busy) return;
    if (called && Date.now() - lastReplyAt < 30_000 && !followup) {
      // 새 호출 쿨다운 30초 — 단 후속 대화(같은 사람)는 기다리게 하지 않는다
      if (m.nickname !== followFrom) return;
    }
    busy = true;
    followFrom = m.nickname; // 후속창은 이 호출자에게 바인딩
    askBrain(m.nickname);
  });
  s.on('disconnect', () => console.log(`[${new Date().toISOString()}] 연결 끊김 — 자동 재접속`));
}
