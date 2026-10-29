/**
 * Settings -> Security -> SSH agent forwarding: the owner grant that forwards the
 * operator's ssh-agent socket into new sessions. One of the sections
 * `SecurityPanel.tsx` composes.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { Badge, Btn } from '../../components/ui'
import { SettingsCard } from '../../components/settings'
import { api, type SshAgentConsentStatus } from '../../api/client'
import { i18nT } from '../../i18n/t'
import { fmtDateTime } from '../../i18n/format'
import ErrorNotice from '../../components/ErrorNotice'

/* ── SSH agent forwarding consent ───────────────────────────────────────────
 *
 * A VIEW over the grant the `/api/ssh-agent/consent` endpoints own: one row, one
 * badge, one action. The owner-gated handler is the only writer and records the
 * grant on Allow, the same one-step shape as the paid-AWS consent. The cached
 * read is never the authority: after a write this card INVALIDATES rather than
 * asserting the new state.
 *
 * Forwarding the ssh-agent socket lets any code a session runs authenticate as
 * the owner with every key the agent holds, for the whole session. That is why
 * the risk line is always visible rather than folded into a tooltip, and why the
 * grant is read at agent SPAWN: sessions already running are unaffected, so the
 * copy says "new sessions" and never implies a running one changed.
 *
 * `socket_present` says whether a new session would have an ssh-agent socket to
 * forward; when it would not, the card says so instead of offering a grant that
 * would forward nothing.
 */
export function SshAgentConsentCard() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery<SshAgentConsentStatus>({
    queryKey: ['ssh-agent-consent'],
    queryFn: api.sshAgentConsent,
    // Not the app-wide `staleTime: Infinity`: another owner tab, or a hand edit
    // of the settings file, can change the grant, and a stale "Not allowed" over
    // a live grant is the dangerous direction. Re-read on focus and remount.
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['ssh-agent-consent'] })
  }
  const grant = useMutation({
    mutationFn: () => api.grantSshAgentConsent(),
    onSettled: invalidate,
  })
  const revoke = useMutation({
    mutationFn: () => api.revokeSshAgentConsent(),
    onSettled: invalidate,
  })

  // An unreadable state renders NO state, gated on `isError` rather than on
  // `data === undefined`, because react-query keeps the last good `data` across
  // a failed refetch and "Not allowed" for a grant that is now live is the
  // dangerous direction of wrong.
  const view = isError ? undefined : data
  const granted = !!view?.granted
  const busy = isLoading || grant.isPending || revoke.isPending

  return (
    <SettingsCard>
      <div className="text-[13px] font-semibold text-text">{i18nT('pages.settings.securityPanel.ssh_agent_title')}</div>
      {/* Purpose FIRST, in body colour: a reader who meets the warning before
          the reason has no reason to ever press the control. Then the risk,
          stated in the open, not behind an InfoTip. */}
      <div className="text-[12px] text-text mt-0.5 leading-relaxed">{i18nT('pages.settings.securityPanel.ssh_agent_when')}</div>
      <p className="text-[12px] text-muted mt-1 mb-2 leading-relaxed flex items-start gap-1">
        <AlertTriangle size={12} className="shrink-0 mt-[3px] text-warn" aria-hidden="true" />
        <span>{i18nT('pages.settings.securityPanel.ssh_agent_risk')}</span>
      </p>

      {view && (
        <div
          data-testid="ssh-agent-row"
          className="flex flex-col gap-1.5 border border-border rounded-md px-3 py-2"
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-text flex items-center gap-1.5 flex-wrap">
                <span>{i18nT('pages.settings.securityPanel.ssh_agent_row_label')}</span>
                {granted
                  ? <Badge variant="ok">{i18nT('pages.settings.securityPanel.ssh_agent_state_allowed')}</Badge>
                  : <Badge variant="muted">{i18nT('pages.settings.securityPanel.ssh_agent_state_not_allowed')}</Badge>}
              </div>
              {/* On a tier that leaves ~/.ssh readable the spawn keeps the socket
                  with no grant, so "Not allowed" and Withdraw would read as
                  stopping a forward they do not stop. */}
              {view.forwarded_without_consent && (
                <div className="text-[11px] text-text mt-0.5 leading-relaxed" data-testid="ssh-agent-tier-forwards">
                  {i18nT('pages.settings.securityPanel.ssh_agent_tier_forwards')}
                </div>
              )}
              {/* The usual default: some harnesses (kiro on the standard level)
                  keep the socket with no grant while masked ones need it. Name
                  them, so "Not allowed" and Withdraw are scoped to the rest. */}
              {!view.forwarded_without_consent && (view.forwarded_harnesses?.length ?? 0) > 0 && (
                <div className="text-[11px] text-text mt-0.5 leading-relaxed" data-testid="ssh-agent-tier-forwards-some">
                  {i18nT('pages.settings.securityPanel.ssh_agent_tier_forwards_some', {
                    harnesses: (view.forwarded_harnesses ?? []).join(', '),
                  })}
                </div>
              )}
              {!view.socket_present && (
                <div className="text-[11px] text-muted mt-0.5 leading-relaxed" data-testid="ssh-agent-no-socket">
                  {i18nT('pages.settings.securityPanel.ssh_agent_no_socket')}
                </div>
              )}
              {granted && (
                <div className="text-[11px] text-muted mt-0.5">
                  {/* A grant with no timestamp was written to the settings file
                      outside this page; say so, or two "Allowed" rows look like
                      two different states for no visible reason. */}
                  {view.granted_at
                    ? <div>{i18nT('pages.settings.securityPanel.ssh_agent_since', { time: fmtDateTime(view.granted_at) })}</div>
                    : <div>{i18nT('pages.settings.securityPanel.ssh_agent_allowed_by_file')}</div>}
                  <div>{i18nT('pages.settings.securityPanel.ssh_agent_applies_new_sessions')}</div>
                </div>
              )}
            </div>
            {granted
              ? (
                <Btn disabled={busy} onClick={() => revoke.mutate()} data-testid="ssh-agent-revoke">
                  {i18nT('pages.settings.securityPanel.ssh_agent_revoke')}
                </Btn>
              )
              : (
                // Disabled while no ssh-agent is visible: a grant made then
                // forwards nothing, and the note above says what to do first.
                <Btn
                  primary
                  disabled={busy || !view.socket_present}
                  onClick={() => grant.mutate()}
                  data-testid="ssh-agent-allow"
                >
                  {i18nT('pages.settings.securityPanel.ssh_agent_allow')}
                </Btn>
              )}
          </div>
          {!granted && view.socket_present && (
            <div className="text-[11px] text-muted mt-0.5 leading-relaxed">
              {i18nT('pages.settings.securityPanel.ssh_agent_allow_help')}
            </div>
          )}
        </div>
      )}

      {isError && (
        <ErrorNotice variant="inline" className="mt-1.5" message={i18nT('pages.settings.securityPanel.ssh_agent_load_failed')} askAgent />
      )}
      {(grant.isError || revoke.isError) && (
        <ErrorNotice variant="inline" className="mt-1.5" message={i18nT('pages.settings.securityPanel.ssh_agent_save_failed')} askAgent />
      )}
    </SettingsCard>
  )
}
