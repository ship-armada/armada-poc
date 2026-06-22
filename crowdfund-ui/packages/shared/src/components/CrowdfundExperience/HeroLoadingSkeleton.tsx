// ABOUTME: Loading skeleton for the CrowdfundExperience left-stack while live crowdfund data is being fetched.
// ABOUTME: Co-located with the hero — promoted to a shared primitive only if/when the designer ships a skeleton in the mockup.

import styles from './HeroLoadingSkeleton.module.css'

interface BlockProps {
  className?: string
}

function Block({ className }: BlockProps) {
  return <div className={[styles.block, className].filter(Boolean).join(' ')} aria-hidden />
}

export function HeroLoadingSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: 'contents' }}>
      <div className={styles.progressCard}>
        <div className={styles.progressHeader}>
          <Block className={styles.progressNumber} />
          <Block className={styles.progressTag} />
        </div>
        <Block className={styles.progressTrack} />
        <div className={styles.progressFootRow}>
          <Block className={styles.progressFootTag} />
          <Block className={styles.progressFootTag} />
        </div>
      </div>

      <div className={styles.participantsCard}>
        <div className={styles.participantsHeader}>
          <Block className={styles.participantsHeaderLeft} />
          <Block className={styles.participantsHeaderRight} />
        </div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={styles.participantRow}>
            <Block className={styles.participantAvatar} />
            <Block className={styles.participantAddress} />
            <Block className={styles.participantHop} />
            <Block className={styles.participantAmount} />
          </div>
        ))}
      </div>
    </div>
  )
}
