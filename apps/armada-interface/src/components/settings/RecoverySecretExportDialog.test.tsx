// ABOUTME: Tests for RecoverySecretExportDialog — file mode (passphrase + download) and hex mode (reveal).
// ABOUTME: Hook + keyManager mocked at the import boundary; URL.createObjectURL stubbed for jsdom.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { RecoverySecretExportDialog } from './RecoverySecretExportDialog'

// vi.mock factories run at module top, BEFORE module-scope `const` initializers — use
// vi.hoisted to declare the mock fns alongside the mocks themselves.
const { mockExportBackup, mockGetRootSecret } = vi.hoisted(() => ({
  mockExportBackup: vi.fn(),
  mockGetRootSecret: vi.fn(),
}))

vi.mock('@/hooks/useShieldedWallet', () => ({
  useShieldedWallet: () => ({
    state: null,
    enroll: vi.fn(),
    unlockByPaste: vi.fn(),
    unlockByBackup: vi.fn(),
    exportBackup: mockExportBackup,
    lock: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock('@/lib/shielded/keyManager', () => ({
  getRootSecret: mockGetRootSecret,
}))

function renderDialog() {
  const store = createStore()
  const onClose = vi.fn()
  render(
    <Provider store={store}>
      <RecoverySecretExportDialog open onClose={onClose} />
    </Provider>,
  )
  return { onClose }
}

beforeEach(() => {
  mockExportBackup.mockReset()
  mockGetRootSecret.mockReset()
})

describe('<RecoverySecretExportDialog> — file mode', () => {
  it('renders with both tabs and the file passphrase form selected by default', () => {
    renderDialog()
    expect(screen.getByRole('dialog', { name: 'Export recovery secret' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Backup file' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Show hex' })).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument()
  })

  it('disables Download until a passphrase is entered', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: /Download backup/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pw-here-strong' } })
    expect(screen.getByRole('button', { name: /Download backup/ })).not.toBeDisabled()
  })

  it('calls exportBackup with the passphrase and shows success on download', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    mockExportBackup.mockResolvedValueOnce({
      format: 'armada-backup-v1',
      kdf: 'pbkdf2-sha256',
      kdf_params: { iterations: 600000 },
      kdf_salt: 'aa',
      cipher: 'aes-256-gcm',
      nonce: 'bb',
      ciphertext: 'cc',
      tag: 'dd',
    })

    renderDialog()
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pw-here-strong' } })
    fireEvent.click(screen.getByRole('button', { name: /Download backup/ }))

    await waitFor(() => {
      expect(mockExportBackup).toHaveBeenCalledWith('pw-here-strong')
      expect(createUrl).toHaveBeenCalled()
      expect(screen.getByText(/Backup downloaded/)).toBeInTheDocument()
    })

    createUrl.mockRestore()
    revokeUrl.mockRestore()
  })

  it('surfaces an exportBackup error inline', async () => {
    mockExportBackup.mockRejectedValueOnce(new Error('wallet is locked'))
    renderDialog()
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pw-here-strong' } })
    fireEvent.click(screen.getByRole('button', { name: /Download backup/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/locked/))
  })
})

describe('<RecoverySecretExportDialog> — hex mode', () => {
  it('reveals the recovery secret hex when the unlocked keyManager has root_secret', () => {
    const root = new Uint8Array(32)
    for (let i = 0; i < 32; i++) root[i] = i + 1
    mockGetRootSecret.mockReturnValueOnce(root)
    renderDialog()
    fireEvent.click(screen.getByRole('tab', { name: 'Show hex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal hex' }))
    const expected = Array.from(root, b => b.toString(16).padStart(2, '0')).join('')
    expect(screen.getByLabelText('Recovery secret (hex)')).toHaveTextContent(expected)
  })

  it('surfaces an error when the keyManager is locked', () => {
    mockGetRootSecret.mockImplementation(() => { throw new Error('wallet is locked') })
    renderDialog()
    fireEvent.click(screen.getByRole('tab', { name: 'Show hex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal hex' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/locked/)
  })
})
