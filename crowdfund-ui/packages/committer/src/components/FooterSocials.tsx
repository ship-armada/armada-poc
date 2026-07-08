// ABOUTME: Discord + X social links row, shown beneath "Return" in the participate-flow invite card.
// ABOUTME: Same glyphs/URLs that previously sat in the header; passed as the ParticipateFlowInviteSlots `socials` slot.

import { DiscordIcon, XIcon } from '@/components/SocialIcons'
import { DISCORD_URL, X_URL } from '@/config/socials'

export function FooterSocials() {
  return (
    <div className="flex items-center justify-center gap-4">
      <a
        href={DISCORD_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Armada on Discord"
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <DiscordIcon className="size-5" />
      </a>
      <a
        href={X_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Armada on X"
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <XIcon className="size-5" />
      </a>
    </div>
  )
}
