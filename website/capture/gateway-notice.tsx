/**
 * Isolated capture entry for the gateway status-row notices.
 *
 * WHY ISOLATED: each row is a recovery or empty-response outcome a live gateway
 * produces only after a real connection loss, a busy session, a stalled turn or
 * an empty model reply. The REAL transcript renderer registry draws them here
 * from fabricated rows carrying the gateway's English content and its notice
 * token, nothing stubbed but the data.
 *
 * Query: ?theme=dark|light&lang=en|de
 */
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'

import { initI18n } from '../src/i18n/all'
import { mergeRenderers, resolveRenderer, type MessageRenderContext } from '../src/app-sdk/messageRenderers'
import { createTranscriptRenderers } from '../src/pages/chat/transcriptRenderers'
import type { ChatMessage } from '../src/types'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') || 'dark'
const lang = params.get('lang') || 'en'
document.documentElement.setAttribute('data-theme', theme === 'light' ? 'kiro-light' : 'kiro-dark')

const row = (role: string, content: string, meta: Record<string, unknown>): ChatMessage =>
  ({ role, content, cls: '', meta }) as unknown as ChatMessage

const ROWS: ChatMessage[] = [
  row('error', '⟳ Connection lost (exit 1) — please retry.', { notice: 'connection_lost_give_up', notice_args: { exit_code: 1 } }),
  row('error', '⟳ Session busy — please retry.', { notice: 'session_busy_give_up' }),
  row('error', '⟳ Turn stalled — please retry.', { notice: 'turn_stalled_give_up' }),
  row('error', 'Session stuck — please start a new chat.', { notice: 'session_stuck' }),
  row('notice', 'ℹ The model returned nothing this turn. Just send your message again to continue.', {
    kind: 'empty_turn_notice',
    notice: 'empty_turn_give_up',
  }),
  row('notice', "⚠ Your account cannot use model 'claude-opus' — running on 'auto' instead.", {
    notice: 'model_access_fallback',
    notice_args: { rejected: 'claude-opus', model: 'auto' },
  }),
]

/** The remaining families, drawn in their own scene. */
const MORE_ROWS: ChatMessage[] = [
  row('error', '⟳ Connection lost — retrying…', { kind: 'transient_retry', notice: 'connection_lost_retrying' }),
  row('error', '⟳ Session busy — retrying…', { kind: 'transient_retry', notice: 'session_busy_retrying' }),
  row('error', '⟳ Recovering a stalled turn…', { kind: 'transient_retry', notice: 'turn_stalled_recovering' }),
  row('error', '⟳ Tool appeared stalled — please retry.', { notice: 'tool_stalled_give_up' }),
  row('error', 'The agent process this chat shares kept restarting — please retry.', { notice: 'shared_runtime_restarting' }),
  row('notice', 'ℹ The model returned nothing — auto-continuing (recovery 2 of 3).', {
    kind: 'empty_turn_notice',
    notice: 'empty_turn_continuing',
    notice_args: { n: 2, max: 3 },
  }),
  row('notice', 'ℹ The turn ended without a closing reply. Send a message to continue from where it stopped — completed steps will not re-run.', {
    kind: 'empty_turn_notice',
    notice: 'empty_turn_after_work',
  }),
  row('notice', 'ℹ️ The context was compacted mid-turn and the response stopped there — continuing automatically.', {
    kind: 'empty_turn_notice',
    notice: 'compaction_continuing',
  }),
  row(
    'notice',
    "claude-opus isn't offered right now — this session is running on auto instead. Pick another model from the composer, or leave it: your model choice is kept and will be used automatically once it's offered again.",
    { notice: 'model_unavailable', notice_args: { model: 'claude-opus' } },
  ),
]

const registry = mergeRenderers(createTranscriptRenderers({ slot: 's1', continuable: false, interrupted: false }))

function draw(m: ChatMessage, index: number): ReactNode {
  const entry = resolveRenderer(m, registry)
  const ctx = {
    index,
    messages: [m],
    running: false,
    key: `k${index}`,
    onFileOpen: () => {},
    hideCardOwnedOAuth: false,
    autoDeniedIds: new Set<string>(),
    wrapper: (children: ReactNode) => children,
    row: (children: ReactNode) => children,
  } as unknown as MessageRenderContext
  return entry ? entry.render(m, ctx) : null
}

initI18n(lang)
createRoot(document.getElementById('root')!).render(
  <div style={{ background: 'var(--bg)', color: 'var(--text)', padding: 16 }}>
    <div data-scene="rows" style={{ width: 640, padding: 8, display: 'grid', gap: 8 }}>
      <div className="font-mono text-[11px] text-muted">Gateway status rows ({lang})</div>
      {ROWS.map((m, i) => (
        <div key={i}>{draw(m, i)}</div>
      ))}
    </div>
    <div data-scene="more" style={{ width: 640, padding: 8, display: 'grid', gap: 8, marginTop: 24 }}>
      <div className="font-mono text-[11px] text-muted">More gateway status rows ({lang})</div>
      {MORE_ROWS.map((m, i) => (
        <div key={i}>{draw(m, i)}</div>
      ))}
    </div>
  </div>,
)
