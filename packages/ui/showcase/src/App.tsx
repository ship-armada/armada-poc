// ABOUTME: Showcase page rendering every @armada/ui primitive for pixel-compare with the mockup.
// ABOUTME: Layout chrome here is incidental; primitives render with their own CSS Modules.

import {
  Button,
  Tag,
  NavBar,
  NavItem,
  Header,
  Progress,
  BarTrackTicks,
  WalletButton,
  Steps,
  Tooltip,
  WalletItem,
  type NavBarItem,
} from '@armada/ui'
import s from './showcase.module.css'

const NAV: NavBarItem[] = [
  { label: 'The project' },
  { label: 'Crowdfund', active: true },
  { label: 'My position' },
  { label: 'Claim' },
]

const COLOR_SWATCHES = [
  { name: 'brand.lavender', token: '--semantic-color-brand-lavender' },
  { name: 'brand.amber', token: '--semantic-color-brand-amber' },
  { name: 'brand.amber-dark', token: '--semantic-color-brand-amber-dark' },
  { name: 'brand.deep', token: '--semantic-color-brand-deep' },
  { name: 'surface.bg', token: '--semantic-color-surface-bg' },
  { name: 'surface.default', token: '--semantic-color-surface-default' },
  { name: 'surface.raised', token: '--semantic-color-surface-raised' },
  { name: 'status.success', token: '--semantic-color-status-success' },
  { name: 'status.warning', token: '--semantic-color-status-warning' },
  { name: 'status.error', token: '--semantic-color-status-error' },
  { name: 'status.info', token: '--semantic-color-status-info' },
]

export function App() {
  return (
    <>
      <div className={s.bgRadial} aria-hidden />

      <Header activeNav="crowdfund" autoHideOnScroll={false} className={s.headerInset} />

      <main className={s.page}>
        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>@armada/ui showcase</h2>
            <span className={s.dim}>foundational primitives ported from the armada-crowdfund mockup</span>
          </div>
          <div className={s.callout}>
            Open this alongside <code>/Volumes/T7/armada-crowdfund</code> (port 5173) and verify each primitive
            renders identically. Differences indicate a token or port regression — file under the design system,
            not the consuming app.
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>Buttons</h2>
            <span className={s.dim}>4 variants × 3 sizes × with/without trailing icon</span>
          </div>

          <p className={s.subhead}>Primary</p>
          <div className={s.row}>
            <Button variant="primary" size="sm" label="Small" />
            <Button variant="primary" size="md" label="Medium" />
            <Button variant="primary" size="lg" label="Large" />
            <Button variant="primary" size="md" label="No icon" showIcon={false} />
            <Button variant="primary" size="md" label="Disabled" disabled />
          </div>

          <p className={s.subhead}>Secondary</p>
          <div className={s.row}>
            <Button variant="secondary" size="sm" label="Small" />
            <Button variant="secondary" size="md" label="Medium" />
            <Button variant="secondary" size="lg" label="Large" />
            <Button variant="secondary" size="md" label="No icon" showIcon={false} />
            <Button variant="secondary" size="md" label="Disabled" disabled />
          </div>

          <p className={s.subhead}>Ghost</p>
          <div className={s.row}>
            <Button variant="ghost" size="sm" label="Small" />
            <Button variant="ghost" size="md" label="Medium" />
            <Button variant="ghost" size="lg" label="Large" />
            <Button variant="ghost" size="md" label="No icon" showIcon={false} />
          </div>

          <p className={s.subhead}>Gradient</p>
          <div className={s.row}>
            <Button variant="gradient" size="sm" label="Small" />
            <Button variant="gradient" size="md" label="Medium" />
            <Button variant="gradient" size="lg" label="Large" />
            <Button variant="gradient" size="md" label="Participate" />
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>Tags</h2>
            <span className={s.dim}>label + optional status dot</span>
          </div>
          <div className={s.row}>
            <Tag label="DEFAULT" />
            <Tag label="ACTIVE" dot="active" />
            <Tag label="WARNING" dot="warning" />
            <Tag label="ERROR" dot="error" />
            <Tag label="NEUTRAL" dot="neutral" />
            <Tag label="LAVENDER" dot="lavender" />
            <Tag label="3 DAYS LEFT" />
            <Tag label="85 PARTICIPANTS" />
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>Nav</h2>
            <span className={s.dim}>NavItem (default + active) and NavBar composition</span>
          </div>

          <p className={s.subhead}>NavItem — isolated</p>
          <div className={s.row}>
            <NavItem label="Default" />
            <NavItem label="Active" active />
          </div>

          <p className={s.subhead}>NavBar</p>
          <div className={s.row}>
            <NavBar items={NAV} />
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>Progress</h2>
            <span className={s.dim}>default card (status + bar) and dashboard variant (hideStatus)</span>
          </div>

          <p className={s.subhead}>Default — animated count-up on mount</p>
          <div className={s.row}>
            <Progress />
          </div>

          <p className={s.subhead}>Static — animateOnMount=false</p>
          <div className={s.row}>
            <Progress animateOnMount={false} />
          </div>

          <p className={s.subhead}>Dashboard layout — hideStatus</p>
          <div className={s.row}>
            <Progress hideStatus />
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>WalletButton</h2>
            <span className={s.dim}>gradient-border pill — connected-state visual; wallet logic lives in the consuming app</span>
          </div>
          <div className={s.row}>
            <WalletButton label="0x63c2…84c6" />
            <WalletButton label="Connect Wallet" />
            <WalletButton label="vitalik.eth" />
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>BarTrackTicks</h2>
            <span className={s.dim}>tick layer for the Progress bar, shown in isolation</span>
          </div>
          <div className={s.row}>
            <div style={{ position: 'relative', width: 582, height: 10 }}>
              <BarTrackTicks />
            </div>
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>Steps</h2>
            <span className={s.dim}>multi-step progress indicator — default, error, confirmed</span>
          </div>

          <p className={s.subhead}>Default — step 2 of 4 active</p>
          <div className={s.row}>
            <div style={{ width: 360 }}>
              <Steps steps={['Wallet', 'Commit', 'Review', 'Approve']} currentStep={2} />
            </div>
          </div>

          <p className={s.subhead}>Error — step 3 of 4 failed</p>
          <div className={s.row}>
            <div style={{ width: 360 }}>
              <Steps steps={['Wallet', 'Commit', 'Review', 'Approve']} currentStep={3} status="error" />
            </div>
          </div>

          <p className={s.subhead}>Confirmed — all segments succeeded</p>
          <div className={s.row}>
            <div style={{ width: 360 }}>
              <Steps steps={['Wallet', 'Commit', 'Review', 'Approve']} currentStep={4} status="confirmed" />
            </div>
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>Tooltip</h2>
            <span className={s.dim}>hover/focus the trigger — centered (single line) and rich (title + bullets) variants</span>
          </div>
          <div className={s.row} style={{ paddingTop: 60 }}>
            <Tooltip variant="centered" content="A short helpful note.">
              <Button variant="secondary" size="md" label="Centered" showIcon={false} />
            </Tooltip>
            <Tooltip
              variant="rich"
              title="Pro-rata allocation"
              description="Your committed amount earns a share of the sale, calculated at finalization."
              bullets={['Capped at hop maximum', 'Excess refunded in USDC', 'ARM delegation required']}
            >
              <Button variant="secondary" size="md" label="Rich" showIcon={false} />
            </Tooltip>
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>WalletItem</h2>
            <span className={s.dim}>full-width clickable row for wallet pickers</span>
          </div>
          <div className={s.row} style={{ flexDirection: 'column', alignItems: 'stretch', maxWidth: 320 }}>
            <WalletItem name="MetaMask" balance="0.45 ETH" onClick={() => {}} />
            <WalletItem name="WalletConnect" onClick={() => {}} />
            <WalletItem name="Coinbase Wallet" balance="—" onClick={() => {}} disabled />
          </div>
        </section>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h2 className={s.h2}>Color tokens</h2>
            <span className={s.dim}>semantic layer — values live in src/styles/tokens.css</span>
          </div>
          <div className={s.swatchGrid}>
            {COLOR_SWATCHES.map(c => (
              <div key={c.token} className={s.swatch}>
                <div className={s.swatchBox} style={{ background: `var(${c.token})` }} />
                <span>{c.name}</span>
                <span className={s.swatchLabel}>{c.token}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  )
}
