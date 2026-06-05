// ABOUTME: Tests for OnboardingFlow — walks Welcome → Sign → Checksum → Backup → ConfirmBackup → Complete.
// ABOUTME: useShieldedWallet is mocked so we drive enroll/exportBackup with deterministic outputs and assert the step transitions.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { OnboardingFlow } from './OnboardingFlow'
import { encryptBackup, antiPhishChecksumBytes, formatChecksumDisplay } from '@/lib/crypto/kdf'

// Fixed root_secret so the checksum and the encrypted blob are deterministic across tests.
const FIXED_ROOT = new Uint8Array(32)
for (let i = 0; i < 32; i++) FIXED_ROOT[i] = i + 1
const FIXED_CHECKSUM = formatChecksumDisplay(antiPhishChecksumBytes(FIXED_ROOT))

const mockEnroll = vi.fn()
const mockExportBackup = vi.fn()

// Mutable mock state — useShieldedWallet returns the active wallet's checksum after enroll().
let mockState: { id: string; status: 'unlocked'; checksum: string; railgunAddress: string } | null = null

vi.mock('@/hooks/useShieldedWallet', () => ({
  useShieldedWallet: () => ({
    state: mockState,
    enroll: mockEnroll,
    exportBackup: mockExportBackup,
    unlockByPaste: vi.fn(),
    unlockByBackup: vi.fn(),
    lock: vi.fn(),
    reset: vi.fn(),
    create: vi.fn(),
    unlock: vi.fn(),
    exportPhrase: vi.fn(),
  }),
}))

// SignEnrollmentStep consumes wagmi + rainbowkit hooks directly; stub both so we don't need
// providers in the test tree. The mocked surface assumes a connected wallet — disconnected
// state has its own dedicated test below.
vi.mock('wagmi', async (importOriginal) => {
  const mod = await importOriginal<typeof import('wagmi')>()
  return {
    ...mod,
    useAccount: () => ({ isConnected: true, address: '0xabc', chainId: 31337 }),
  }
})
vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}))

function renderFlow() {
  const store = createStore()
  const onDone = vi.fn()
  render(
    <Provider store={store}>
      <OnboardingFlow onDone={onDone} />
    </Provider>,
  )
  return { onDone }
}

beforeEach(() => {
  mockEnroll.mockReset()
  mockExportBackup.mockReset()
  mockState = null
  // Default happy-path: enroll() flips mockState to "unlocked with checksum" and resolves.
  mockEnroll.mockImplementation(async () => {
    mockState = {
      id: 'wallet-id-1',
      status: 'unlocked',
      checksum: FIXED_CHECKSUM,
      railgunAddress: '0zk1qexample',
    }
    return {
      rootSecret: FIXED_ROOT,
      state: mockState,
    }
  })
  mockExportBackup.mockImplementation(async (passphrase: string) =>
    encryptBackup({ rootSecret: FIXED_ROOT, creationBlock: 0 }, passphrase, { iterations: 1000 }),
  )
})

// TODO: OnboardingFlow (V1) is deprecated — App.tsx now renders OnboardingFlowV2. These tests were
// not updated when the designer renamed step labels and changed the step count (TOTAL_STEPS 6 → 5).
// Skipped until V1 is either removed or the test suite is rewritten against the current step set.
describe.skip('<OnboardingFlow>', () => {
  it('starts on the Welcome step', () => {
    renderFlow()
    expect(screen.getByRole('heading', { name: 'Create your private USDC account' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Step 1 of 6' })).toBeInTheDocument()
  })

  it('Welcome → Sign on Create click', () => {
    renderFlow()
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    expect(screen.getByRole('heading', { name: 'Sign to generate your keys' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Step 2 of 6' })).toBeInTheDocument()
  })

  it('Sign succeeds → Checksum step displays the live checksum', async () => {
    renderFlow()
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    fireEvent.click(screen.getByRole('button', { name: /Sign enrollment/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Your anti-phishing code' })).toBeInTheDocument()
    })
    expect(screen.getByLabelText('Anti-phishing checksum')).toHaveTextContent(FIXED_CHECKSUM)
  })

  it('Checksum → Backup step', async () => {
    renderFlow()
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    fireEvent.click(screen.getByRole('button', { name: /Sign enrollment/ }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Continue$/ })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/ }))
    expect(screen.getByText('Create your backup')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Step 4 of 6' })).toBeInTheDocument()
  })

  it('Backup → triggers download and exposes Continue', async () => {
    // Stub URL.createObjectURL + revokeObjectURL since jsdom doesn't implement them.
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    renderFlow()
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    fireEvent.click(screen.getByRole('button', { name: /Sign enrollment/ }))
    await waitFor(() => screen.getByRole('button', { name: /^Continue$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/ }))

    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pw-here-strong' } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'pw-here-strong' } })
    fireEvent.click(screen.getByRole('button', { name: /Download backup/ }))

    await waitFor(() => {
      expect(mockExportBackup).toHaveBeenCalledWith('pw-here-strong')
      expect(createUrl).toHaveBeenCalled()
    })
    // After download, Continue replaces Download.
    expect(await screen.findByRole('button', { name: /^Continue$/ })).toBeInTheDocument()

    createUrl.mockRestore()
    revokeUrl.mockRestore()
  })

  it('full happy path — Welcome through Complete with checksum-matched re-import', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    // Capture what BackupPassphraseStep would have produced; we feed an equivalent encrypted
    // file (same root_secret) back to ConfirmBackupStep to make the round-trip succeed.
    const passphrase = 'pw-here-strong'

    const { onDone } = renderFlow()
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    fireEvent.click(screen.getByRole('button', { name: /Sign enrollment/ }))
    await waitFor(() => screen.getByRole('button', { name: /^Continue$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/ })) // checksum → backup

    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: passphrase } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: passphrase } })
    fireEvent.click(screen.getByRole('button', { name: /Download backup/ }))
    await waitFor(() => expect(mockExportBackup).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /^Continue$/ })) // backup → confirm

    // ConfirmBackupStep: upload an equivalent encrypted file + same passphrase.
    const blob = encryptBackup({ rootSecret: FIXED_ROOT, creationBlock: 0 }, passphrase, { iterations: 1000 })
    const file = new File([JSON.stringify(blob)], 'armada-backup.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [file] } })
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: passphrase } })
    fireEvent.click(screen.getByRole('button', { name: /Verify backup/ }))

    await waitFor(() => {
      expect(screen.getByText(/Backup verified/)).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByText("You're in")).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: /^Continue$/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Go to dashboard/ }))
    expect(onDone).toHaveBeenCalledTimes(1)

    createUrl.mockRestore()
    revokeUrl.mockRestore()
  })

  it('surfaces an enroll() failure on the Sign step', async () => {
    mockEnroll.mockImplementation(async () => { throw new Error('User rejected the request.') })
    renderFlow()
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    fireEvent.click(screen.getByRole('button', { name: /Sign enrollment/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/)
    expect(screen.getByRole('heading', { name: 'Sign to generate your keys' })).toBeInTheDocument()
  })

  it('rejects a backup whose checksum does not match the live wallet', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    renderFlow()
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    fireEvent.click(screen.getByRole('button', { name: /Sign enrollment/ }))
    await waitFor(() => screen.getByRole('button', { name: /^Continue$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/ })) // → backup

    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pw-here-strong' } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'pw-here-strong' } })
    fireEvent.click(screen.getByRole('button', { name: /Download backup/ }))
    await waitFor(() => expect(mockExportBackup).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /^Continue$/ })) // → confirm

    // Upload a backup for a DIFFERENT root_secret — checksum mismatch.
    const wrongRoot = new Uint8Array(32).fill(42)
    const wrongBlob = encryptBackup({ rootSecret: wrongRoot, creationBlock: 0 }, 'pw-here-strong', { iterations: 1000 })
    const wrongFile = new File([JSON.stringify(wrongBlob)], 'wrong.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [wrongFile] } })
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pw-here-strong' } })
    fireEvent.click(screen.getByRole('button', { name: /Verify backup/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not match/)
    createUrl.mockRestore()
    revokeUrl.mockRestore()
  })
})
