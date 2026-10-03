// ABOUTME: Leave guard for the /invite flow's close control — asks before leaving while a commit pipeline runs.
// ABOUTME: Leaving pauses the pipeline; reopening the invite link re-attaches and finishes the remaining steps.

const LEAVE_CONFIRM_MESSAGE =
  'A transaction is still running. It will continue, and you can reopen this invite link to finish the remaining steps. Leave?'

/** Whether the /invite flow may leave. While a tx pipeline is running, asks the user first. */
export function confirmLeaveInviteFlow(running: boolean): boolean {
  return !running || window.confirm(LEAVE_CONFIRM_MESSAGE)
}
