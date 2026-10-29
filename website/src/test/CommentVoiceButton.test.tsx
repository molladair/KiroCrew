import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

// A hand-driven engine: the test plays the transcriber by calling `deliver`.
const engine = vi.hoisted(() => ({
  recording: false,
  transcribing: false,
  sessionOwner: null as string | null,
  error: null as string | null,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  onText: null as null | ((text: string, sid: string | null) => void),
  sessionId: null as string | null,
}))
vi.mock('../hooks/useVoiceInput', () => ({
  voiceInputSupported: true,
  useVoiceInput: (onText: (t: string, sid: string | null) => void, opts: { sessionId?: string | null }) => {
    engine.onText = onText
    engine.sessionId = opts.sessionId ?? null
    return { ...engine }
  },
}))
vi.mock('../api/client', () => ({ api: { sttConfig: vi.fn() } }))

import { CommentVoiceButton, appendDictation } from '../components/CommentVoiceButton'
import { _resetMicOwner, readMicOwner, setMicOwner } from '../chat-core/composer/useComposerVoice'

function renderWith(cfg: object | null, ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (cfg) qc.setQueryData(['sttConfig'], cfg)
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function Box() {
  const [text, setText] = useState('Hello')
  return (<>
    <textarea aria-label="box" value={text} onChange={e => setText(e.target.value)} />
    <CommentVoiceButton onText={t => setText(prev => appendDictation(prev, t))} />
  </>)
}

const ON = { enabled: true, available: true, streaming: false }

beforeEach(() => {
  Object.assign(engine, { recording: false, transcribing: false, sessionOwner: null, error: null })
  engine.start.mockReset(); engine.stop.mockReset(); engine.cancel.mockReset()
  _resetMicOwner()
})

describe('CommentVoiceButton', () => {
  it('fills the box with the transcript and never sends it', () => {
    renderWith(ON, <Box />)
    fireEvent.click(screen.getByTestId('comment-voice'))
    expect(engine.start).toHaveBeenCalledTimes(1)
    act(() => { engine.onText!('please fix this', engine.sessionId) })
    expect((screen.getByLabelText('box') as HTMLTextAreaElement).value).toBe('Hello please fix this')
  })

  it('ignores a transcript for another session', () => {
    renderWith(ON, <Box />)
    act(() => { engine.onText!('not mine', 'chat-slot-1') })
    expect((screen.getByLabelText('box') as HTMLTextAreaElement).value).toBe('Hello')
  })

  it('is hidden while voice is off, and without a query client', () => {
    const { unmount } = renderWith({ enabled: false, available: true }, <Box />)
    expect(screen.queryByTestId('comment-voice')).toBeNull()
    unmount()
    render(<CommentVoiceButton onText={() => {}} />)
    expect(screen.queryByTestId('comment-voice')).toBeNull()
  })

  it('does not start while another composer holds the mic', () => {
    setMicOwner('someone-else')
    renderWith(ON, <Box />)
    const btn = screen.getByTestId('comment-voice') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(engine.start).not.toHaveBeenCalled()
  })

  it('a second press stops, and closing the box mid-recording discards', () => {
    engine.recording = true
    const { unmount } = renderWith(ON, <Box />)
    fireEvent.click(screen.getByTestId('comment-voice'))
    expect(engine.stop).toHaveBeenCalledTimes(1)
    unmount()
    expect(engine.cancel).toHaveBeenCalledTimes(1)
    expect(readMicOwner()).toBeNull()
  })
})

describe('appendDictation', () => {
  it('spaces Latin text and joins Han text without a space', () => {
    expect(appendDictation('', ' hi ')).toBe('hi')
    expect(appendDictation('Hello', 'world')).toBe('Hello world')
    expect(appendDictation('你好', '世界')).toBe('你好世界')
    expect(appendDictation('keep', '   ')).toBe('keep')
  })
})
