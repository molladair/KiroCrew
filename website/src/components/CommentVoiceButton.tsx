import { useCallback, useContext, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { QueryClientContext, useQuery } from '@tanstack/react-query'
import { Loader2, Mic, Square } from 'lucide-react'
import { api } from '../api/client'
import { useVoiceInput, voiceInputSupported } from '../hooks/useVoiceInput'
import { subscribeTranscripts } from '../hooks/voiceTranscriptInbox'
import { readMicOwner, setMicOwner, subscribeMic, type SttConfig } from '../chat-core/composer/useComposerVoice'
import { dictationSeparator } from '../lib/dictationText'
import { i18nT } from '../i18n/t'

/**
 * Dictate into a comment box: press to record, press again to stop, and the
 * words are ADDED to the box for the person to read before they send. Nothing
 * is posted by this button.
 *
 * It rides the chat composer's engine (`useVoiceInput`) and its one-mic lock,
 * so a comment dictation never runs beside a chat dictation. Each button speaks
 * for its own session id, `comment-voice:<id>`, so a transcript reaches only the
 * box that recorded it and never a chat draft.
 */
const SLOT_PREFIX = 'comment-voice:'

// A comment transcript can settle after its box closed (stop, then close
// before the transcriber answers). Without an owner the inbox hands unowned
// text to the chat page, which would file it as a draft for a chat that does
// not exist. This sink claims every comment session and drops the text; a
// mounted button subscribes later and so wins the inbox's last-subscribed tie.
subscribeTranscripts({ begin: () => {}, settle: () => {}, owns: s => !!s?.startsWith(SLOT_PREFIX) })

/** `base` with the dictated `text` added at the end, spaced like the composer. */
export function appendDictation(base: string, text: string): string {
  const t = text.trim()
  if (!t) return base
  return base + dictationSeparator(base, t) + t
}

interface Props {
  onText: (text: string) => void
  disabled?: boolean
  className?: string
}

/** No button off a QueryClient (a bare embed or test): the voice settings
 *  cannot be read there, and a mic that cannot tell whether voice is on would
 *  record audio that is never transcribed. */
export function CommentVoiceButton(props: Props) {
  return useContext(QueryClientContext) != null ? <CommentVoiceButtonInner {...props} /> : null
}

function CommentVoiceButtonInner({ onText, disabled, className = '' }: Props) {
  const id = useId()
  const slot = SLOT_PREFIX + id
  const { data: cfg } = useQuery({
    queryKey: ['sttConfig'],
    queryFn: () => api.sttConfig() as Promise<SttConfig>,
  })
  // Same rule as the composer: stream only when the provider can.
  const streaming = !!cfg?.streaming && (
    !Array.isArray(cfg?.streaming_providers)
    || (typeof cfg?.provider === 'string' && cfg.streaming_providers.includes(cfg.provider))
  )
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  // True from this button's press until its words land, so an error the inbox
  // broadcasts for someone else's recording is not shown here.
  const [mine, setMine] = useState(false)
  const deliver = useCallback((text: string, sid: string | null) => {
    if (sid !== slot) return
    setMine(false)
    onTextRef.current(text)
  }, [slot])
  const owns = useCallback((sid: string | null) => sid === slot, [slot])
  const voice = useVoiceInput(deliver, { streaming, sessionId: slot, ownsSession: owns, acceptsUnowned: false })

  const owner = useSyncExternalStore(subscribeMic, readMicOwner, readMicOwner)
  const startingRef = useRef(false)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // Let go of the lock once this button's capture and transcription are over.
  useEffect(() => {
    if (readMicOwner() === id && !startingRef.current && !voice.recording && !voice.transcribing) setMicOwner(null)
  })
  // Closing the box discards a dictation still recording. A layout cleanup, so
  // it runs before the engine's own unmount stops the recorder, which would
  // otherwise transcribe the audio for a box that is gone.
  const cancelRef = useRef(voice.cancel)
  cancelRef.current = voice.cancel
  const recordingRef = useRef(voice.recording)
  recordingRef.current = voice.recording
  useLayoutEffect(() => () => {
    if (recordingRef.current) cancelRef.current()
    if (readMicOwner() === id) setMicOwner(null)
  }, [id])

  const ready = voiceInputSupported && !!cfg?.enabled && cfg?.available !== false
  if (!ready) return null

  const ownBusy = voice.transcribing && voice.sessionOwner === slot
  const busyElsewhere = !voice.recording && ((owner !== null && owner !== id) || (voice.transcribing && !ownBusy))
  const error = mine ? voice.error : null

  const toggle = () => {
    if (voice.recording) { voice.stop(); return }
    if (disabled || busyElsewhere || ownBusy || startingRef.current) return
    setMine(true)
    setMicOwner(id, null)
    startingRef.current = true
    void Promise.resolve(voice.start()).finally(() => { startingRef.current = false; rerender() })
  }

  const label = voice.recording
    ? i18nT('components.commentVoiceButton.stop_dictation')
    : ownBusy
      ? i18nT('components.commentVoiceButton.transcribing')
      : busyElsewhere
        ? i18nT('components.commentVoiceButton.mic_in_use')
        : i18nT('components.commentVoiceButton.dictate_comment')
  const tone = error ? 'text-danger bg-transparent hover:bg-bg-hover' : voice.recording ? 'text-accent bg-bg-hover' : 'text-muted bg-transparent hover:text-accent hover:bg-bg-hover'

  return (
    <button
      type="button"
      data-testid="comment-voice"
      // Keep the caret in the comment box, like the box's other buttons.
      onMouseDown={e => e.preventDefault()}
      onClick={toggle}
      disabled={!voice.recording && (disabled || busyElsewhere || ownBusy)}
      aria-pressed={voice.recording}
      aria-label={error ? `${label}: ${error}` : label}
      title={error ?? label}
      className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer border-none disabled:opacity-40 disabled:cursor-default ${tone} ${className}`}
    >
      {ownBusy
        ? <Loader2 size={14} className="animate-spin" />
        : voice.recording
          ? <Square size={11} fill="currentColor" className="animate-pulse" />
          : <Mic size={14} />}
    </button>
  )
}
