import { useAtomValue } from 'jotai'
import { User, Shield } from 'lucide-react'
import { ExplorerLink } from '@/components/common/ExplorerLink'
import { CopyButton } from '@/components/common/CopyButton'
import type { StoredTransaction } from '@/types/transaction'
import { getAddressDisplay } from '@/utils/addressDisplayUtils'
import { formatAddress } from '@/utils/toastHelpers'
import { addressBookAtom } from '@/atoms/addressBookAtom'

export interface AddressDisplaySectionProps {
  address: string | undefined
  label: string
  explorerUrl?: string
  isSender?: boolean
  showAddress: boolean
  onToggleShowAddress: () => void
  transaction: StoredTransaction
}

export function AddressDisplaySection({
  address,
  label,
  explorerUrl,
  isSender: _isSender = false,
  showAddress,
  onToggleShowAddress,
}: AddressDisplaySectionProps) {
  void _isSender // Kept for API compatibility
  if (!address) return null

  const addressBookEntries = useAtomValue(addressBookAtom)
  const addressInfo = getAddressDisplay(address, addressBookEntries)
  const isFromAddressBook = addressInfo?.isFromAddressBook ?? false

  // Check if this is a Railgun address (starts with 0zk)
  const isRailgunAddress = address.startsWith('0zk')

  // Always show the label at the top
  return (
    <div className="space-y-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>

      {/* Case 1: Railgun address (shielded) */}
      {isRailgunAddress && !isFromAddressBook && (
        <>
          <dd>
            <div className="flex items-center gap-1 text-md">
              <Shield className="h-4 w-4 text-primary flex-shrink-0" />
              <span className="font-semibold">Shielded Address</span>
            </div>
          </dd>
          {!showAddress ? (
            <button
              type="button"
              onClick={onToggleShowAddress}
              className="text-xs text-primary hover:text-primary/80 p-0"
            >
              Show address
            </button>
          ) : (
            <dd>
              <div className="flex items-center justify-start gap-2">
                <span className="text-xs text-muted-foreground font-mono">{formatAddress(address)}</span>
                <div className="gap-0 flex">
                  <CopyButton
                    text={address}
                    label={label}
                    size='sm'
                  />
                </div>
              </div>
            </dd>
          )}
        </>
      )}

      {/* Case 2: Regular address (not railgun, not in address book) */}
      {!isRailgunAddress && !isFromAddressBook && (
        <dd>
          <div className="flex items-center justify-start gap-2">
            <span className="text-sm font-mono">{formatAddress(address)}</span>
            <div className="gap-0 flex">
              <CopyButton
                text={address}
                label={label}
                size='md'
              />
              {explorerUrl && (
                <ExplorerLink
                  url={explorerUrl}
                  label={`Open ${label} in explorer`}
                  size='md'
                  iconOnly
                  className="explorer-link-inline"
                />
              )}
            </div>
          </div>
        </dd>
      )}

      {/* Case 3: Address book match */}
      {isFromAddressBook && addressInfo && (
        <>
          <dd>
            <div className="flex items-center gap-1 text-md">
              <User className="h-4 w-4 text-success flex-shrink-0" />
              <span className="font-semibold">{addressInfo.display}</span>
            </div>
          </dd>
          {!showAddress ? (
            <button
              type="button"
              onClick={onToggleShowAddress}
              className="text-xs text-primary hover:text-primary/80 p-0"
            >
              Show address
            </button>
          ) : (
            <dd>
              <div className="flex items-center justify-start gap-2">
                <span className="text-xs text-muted-foreground font-mono">{formatAddress(address)}</span>
                <div className="gap-0 flex">
                  <CopyButton
                    text={address}
                    label={label}
                    size='sm'
                  />
                  {explorerUrl && (
                    <ExplorerLink
                      url={explorerUrl}
                      label={`Open ${label} in explorer`}
                      size='sm'
                      iconOnly
                      className="explorer-link-inline"
                    />
                  )}
                </div>
              </div>
            </dd>
          )}
        </>
      )}
    </div>
  )
}

