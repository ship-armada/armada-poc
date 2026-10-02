// ABOUTME: Pre-commit interstitial — how-to step cards, position table, risks, resource icons.
// ABOUTME: Not a progress step; between invite card and Commit. Skipped after first commit.

import type { CSSProperties, SVGProps } from 'react'
import { DocumentTextIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { Button } from '@armada/ui'
import type { HopVariant } from '../../HopPill/HopPill'
import { hopPillDotColor } from '../../../lib/graphHopColors'
import { DEMO_WALLET, DEMO_WALLET_DISPLAY } from '../../MyPosition/myPositionDemo'
import { FlowChrome } from '../FlowChrome'
import { DISCORD_URL, X_URL } from '../../../lib/socials'
import { CROWDFUND_CONSTANTS } from '../../../lib/constants'
import styles from './StepBeforeYouStart.module.css'

const HOP_TAG_LABEL: Record<HopVariant, string> = {
  seed: 'HOP-0',
  'hop-1': 'HOP-1',
  'hop-2': 'HOP-2',
  'multi-hop': 'MULTI-HOP',
}

function DiscordIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.227-8.451L1.5 2.25h7.08l4.263 5.671L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  )
}

const RESOURCE_LINKS = [
  {
    label: 'Website',
    href: 'https://armada.blue',
    Icon: GlobeAltIcon,
  },
  {
    label: 'Discord',
    href: DISCORD_URL,
    Icon: DiscordIcon,
  },
  {
    label: 'X',
    href: X_URL,
    Icon: XIcon,
  },
] as const

/** Resource tiles plus a Contract tile when the deployed address and explorer are known. */
function resourceLinks(contractAddress: string | undefined, explorerBaseUrl: string | undefined) {
  if (!contractAddress || !explorerBaseUrl) return RESOURCE_LINKS
  return [
    ...RESOURCE_LINKS,
    {
      label: 'Contract',
      href: `${explorerBaseUrl}/address/${contractAddress}`,
      Icon: DocumentTextIcon,
    },
  ]
}

const NEXT_STEPS = [
  { label: 'Commit', hint: 'Choose how much USDC to lock' },
  { label: 'Review', hint: 'Confirm amount and hop details' },
  { label: 'Confirm', hint: 'Approve USDC, then commit in your wallet' },
] as const

export interface StepBeforeYouStartProps {
  hopVariant?: HopVariant
  /** Current-hop commit ceiling in USDC. */
  capUsdc?: number
  /** Outbound invite slots still available (hop-1 + hop-2). */
  inviteCount?: number
  /**
   * Ceiling reachable after self-invites (Max out). When above `capUsdc`,
   * the invite bullet mentions raising the commit limit.
   */
  maxOutCeilingUsdc?: number
  /** Full wallet address (title / hover). */
  walletAddress?: string
  /** Truncated display address (falls back to truncate of walletAddress). */
  walletDisplayAddress?: string
  /** Absolute window-close label, e.g. "14 Oct, 18:00 CET". */
  windowClosesLabel?: string
  onBack: () => void
  onContinue: () => void
  /** Close the participate flow (FlowChrome X). */
  onClose?: () => void
  /** When false, hides the chrome back control (still keeps layout balance). */
  showBack?: boolean
  /** Deployed crowdfund address for the Contract tile. Tile omitted when unset. */
  contractAddress?: string
  /** Block-explorer base URL (no trailing slash). Contract tile omitted when unset. */
  explorerBaseUrl?: string
}

// Minimum raise for the active profile (whole USDC), for the refund bullet.
const minSaleUsdc = Number(CROWDFUND_CONSTANTS.MIN_SALE / 1_000_000n)

function formatUsdc(value: number): string {
  return value.toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })
}

function truncateMiddle(address: string, head = 4, tail = 4): string {
  if (address.length <= head + tail + 1) return address
  return `${address.slice(0, head)}…${address.slice(-tail)}`
}

function inviteSeatHop(hopVariant: HopVariant): 'Hop-1' | 'Hop-2' | null {
  if (hopVariant === 'seed' || hopVariant === 'multi-hop') return 'Hop-1'
  if (hopVariant === 'hop-1') return 'Hop-2'
  return null
}

function inviteBullet(
  hopVariant: HopVariant,
  inviteCount: number,
  capUsdc: number,
  maxOutCeilingUsdc: number | undefined,
): string | null {
  const seatHop = inviteSeatHop(hopVariant)
  if (seatHop == null || inviteCount <= 0) return null

  const inviteWord = inviteCount === 1 ? 'invite' : 'invites'
  const seatWord = inviteCount === 1 ? 'seat' : 'seats'
  const base = `Your position has ${inviteCount} ${inviteWord} for ${seatHop} ${seatWord}.`

  const ceiling =
    maxOutCeilingUsdc != null && maxOutCeilingUsdc > capUsdc ? maxOutCeilingUsdc : null
  if (ceiling == null) {
    return `${base} You can invite others, or self-invite to open additional hop seats.`
  }

  return `${base} You can increase your commit limit by self-inviting — up to $${formatUsdc(ceiling)}.`
}

function knowItems(
  hopVariant: HopVariant,
  inviteCount: number,
  capUsdc: number,
  maxOutCeilingUsdc: number | undefined,
): string[] {
  const items = [
    'You’ll need a little ETH in this wallet for gas. Approving USDC and committing each require a transaction.',
  ]

  const invites = inviteBullet(hopVariant, inviteCount, capUsdc, maxOutCeilingUsdc)
  if (invites) items.push(invites)

  items.push(
    'Allocation isn’t guaranteed. If your hop is oversubscribed you get a pro-rata share and the rest comes back to you.',
    `If the raise ends under $${formatUsdc(minSaleUsdc)}, everyone gets a full refund.`,
    'ARM is claimed after the window closes. Voting power starts once you claim and delegate.',
  )
  return items
}

export default function StepBeforeYouStart({
  hopVariant = 'hop-1',
  capUsdc = 4_000,
  inviteCount = 0,
  maxOutCeilingUsdc,
  walletAddress = DEMO_WALLET,
  walletDisplayAddress,
  windowClosesLabel = '14 Oct, 18:00 CET',
  onBack,
  onContinue,
  onClose,
  showBack = true,
  contractAddress,
  explorerBaseUrl,
}: StepBeforeYouStartProps) {
  const display =
    walletDisplayAddress ??
    (walletAddress === DEMO_WALLET ? DEMO_WALLET_DISPLAY : truncateMiddle(walletAddress))
  const hopDotStyle: CSSProperties = {
    background: hopPillDotColor(hopVariant),
  }
  const knowList = knowItems(hopVariant, inviteCount, capUsdc, maxOutCeilingUsdc)

  return (
    <div className={styles.shell} data-flow-shell>
      <div className={styles.chromeRow}>
        <FlowChrome
          title="Before you start"
          titleId="before-start-title"
          showBack={showBack}
          onBack={onBack}
          onClose={onClose}
        />
      </div>

      <div className={styles.contentWrap}>
        <div className={styles.content}>
          <section className={styles.block} aria-labelledby="before-start-steps">
            <h3 id="before-start-steps" className={styles.blockHeading}>
              How to participate
            </h3>
            <ol className={styles.stepCards} aria-labelledby="before-start-steps">
              {NEXT_STEPS.map((item, index) => (
                <li key={item.label} className={styles.stepCard}>
                  <span className={styles.stepNumber} aria-hidden>
                    {index + 1}
                  </span>
                  <div className={styles.stepCopy}>
                    <span className={styles.stepLabel}>{item.label}</span>
                    <span className={styles.stepHint}>{item.hint}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.block} aria-labelledby="before-start-details">
            <h3 id="before-start-details" className={styles.blockHeading}>
              Your details
            </h3>
            <div className={styles.factsCard}>
              <div className={styles.factRow}>
                <span className={styles.factLabel}>Address</span>
                <span className={styles.factValue} title={walletAddress}>
                  {display}
                </span>
              </div>
              <div className={styles.divider} aria-hidden />
              <div className={styles.factRow}>
                <span className={styles.factLabel}>Your position</span>
                <span className={styles.hopTag}>
                  <span className={styles.hopDot} style={hopDotStyle} aria-hidden />
                  <span className={styles.factValue}>{HOP_TAG_LABEL[hopVariant]}</span>
                </span>
              </div>
              <div className={styles.divider} aria-hidden />
              <div className={styles.factRow}>
                <span className={styles.factLabel}>Hop limit</span>
                <span className={styles.factValue}>{formatUsdc(capUsdc)} USDC</span>
              </div>
              <div className={styles.divider} aria-hidden />
              <div className={styles.factRow}>
                <span className={styles.factLabel}>Window closes</span>
                <span className={styles.factValue}>{windowClosesLabel}</span>
              </div>
            </div>
          </section>

          <section className={styles.block} aria-labelledby="before-start-know">
            <h3 id="before-start-know" className={styles.blockHeading}>
              What to know
            </h3>
            <ul className={styles.knowList}>
              {knowList.map((text) => (
                <li key={text} className={styles.knowItem}>
                  <span className={styles.knowBullet} aria-hidden>
                    ·
                  </span>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.block} aria-labelledby="before-start-links">
            <h3 id="before-start-links" className={styles.blockHeading}>
              Useful links
            </h3>
            <nav className={styles.resourceNav} aria-label="Useful links">
              <ul className={styles.iconLinkList}>
                {resourceLinks(contractAddress, explorerBaseUrl).map(({ label, href, Icon }) => (
                  <li key={href} className={styles.iconLinkItem}>
                    <a
                      className={styles.iconLink}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className={styles.iconTile}>
                        <Icon className={styles.brandIcon} aria-hidden />
                        <span className={styles.iconLabel}>
                          {label}
                          <span className={styles.visuallyHidden}> (opens in a new tab)</span>
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </section>
        </div>
        <div className={styles.contentFade} aria-hidden />
      </div>

      <div className={styles.footer}>
        <div className={styles.buttonRow}>
          <Button
            variant="primary"
            size="lg"
            label="Commit"
            showIcon={false}
            onClick={onContinue}
          />
        </div>
      </div>
    </div>
  )
}
