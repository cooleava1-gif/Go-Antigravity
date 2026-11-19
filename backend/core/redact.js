// Anything that can reach goagy.log, accounts.json or the UI console passes through here.
//
// Why this exists: child_process failures are reported as "Command failed: <full command
// line>", and our curl calls carry the OAuth client secret and the account's refresh token as
// arguments. A single unreachable proxy used to write both secrets into the log file and into
// the account's error field - and the same is true for the Authorization headers of the quota
// calls. Redact at the choke points instead of trusting every call site to be careful.
const MASK = '***';

const RULES = [
  // Named tunnel credentials in structured settings, environment echoes or CLI diagnostics.
  [/(["']?(?:tunnel[_-]?token|cf[_-]tunnel[_-]?token|cloudflared[_-]token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,};&]+)/gi, (_match, prefix) => prefix + MASK],
  [/(--token(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, (_match, prefix) => prefix + MASK],
  // key=value form (curl --data-urlencode / form-encoded bodies)
  [/\b(client_secret|refresh_token|access_token|id_token|code)=([^\s'"&]+)/gi, (_match, key) => `${key}=${MASK}`],
  // JSON form ({"refresh_token":"1//..."})
  [/"(client_secret|refresh_token|access_token|id_token|code)"\s*:\s*"[^"]*"/gi, (_match, key) => `"${key}":"${MASK}"`],
  // Authorization headers echoed back by curl
  [/\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, `Bearer ${MASK}`],
  // Google credential shapes that survive on their own
  [/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, 'GOCSPX-***'],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, 'ya29.***'],
  [/\b1\/\/[A-Za-z0-9_-]{10,}/g, match => `${match.slice(0, 5)}…${match.slice(-4)}`]
];

function redactSecrets(input) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  if (!text) return text;
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return text;
}

// True when a string still carries something that looks like a credential; used by tests and
// by the log rotation guard to avoid persisting an unsanitised line.
function containsSecret(input) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  if (!text) return false;
  return /(?:["']?(?:tunnel[_-]?token|cf[_-]tunnel[_-]?token|cloudflared[_-]token)["']?\s*[:=]\s*["']?|--token(?:=|\s+)["']?)[^\s"'*,};&]{1,}/i.test(text)
    || /\bGOCSPX-[A-Za-z0-9_-]{10,}/.test(text)
    || /\bya29\.[A-Za-z0-9._-]{10,}/.test(text)
    || /\b1\/\/[A-Za-z0-9_-]{10,}/.test(text)
    || /(?:client_secret|refresh_token|access_token|id_token)=[^\s'"&*]{8,}/i.test(text)
    || /Bearer\s+[A-Za-z0-9._~+/-]{10,}=*/i.test(text);
}

module.exports = { redactSecrets, containsSecret, MASK };
