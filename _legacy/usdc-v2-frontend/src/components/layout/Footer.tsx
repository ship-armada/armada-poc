import { Twitter, Github, MessageCircle } from 'lucide-react'

export function Footer() {
  const currentYear = new Date().getFullYear()
  const appVersion = import.meta.env.VITE_APP_VERSION || '0.0.1'

  const socialLinks = [
    {
      name: 'Twitter',
      icon: Twitter,
      href: 'https://twitter.com',
      ariaLabel: 'Follow us on Twitter',
    },
    {
      name: 'GitHub',
      icon: Github,
      href: 'https://github.com',
      ariaLabel: 'Visit our GitHub repository',
    },
    {
      name: 'Discord',
      icon: MessageCircle,
      href: 'https://discord.gg',
      ariaLabel: 'Join our Discord community',
    },
  ]

  return (
    <footer className="border-t border-border bg-background/80 backdrop-blur">
      <div className="container mx-auto px-0 py-4">
        <div className="flex flex-col items-center justify-between gap-4 md:grid md:grid-cols-3">
          {/* Copyright and Version - Left */}
          <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground md:flex-row md:items-start md:justify-start">
            <span>© {currentYear} Borderless Private USDC</span>
            <span className="hidden md:inline">•</span>
            <span>Version {appVersion}</span>
          </div>

          {/* Powered By - Center */}
          <div className="flex items-center gap-3 text-sm text-muted-foreground md:justify-center">
            <span>Railgun-based UX Demo</span>
          </div>

          {/* Social Media Links - Right */}
          <div className="flex items-center gap-4 md:justify-end">
            {socialLinks.map((link) => {
              const Icon = link.icon
              return (
                <a
                  key={link.name}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={link.ariaLabel}
                  className="text-muted-foreground transition-colors hover:text-foreground focus:outline-none rounded-sm"
                >
                  <Icon className="h-5 w-5" />
                </a>
              )
            })}
          </div>
        </div>
      </div>
    </footer>
  )
}

