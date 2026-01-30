import { useLocation, Link } from 'react-router-dom'
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb'

const routeLabels: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/send': 'Send Payment',
  '/deposit': 'Deposit',
  '/history': 'Transaction History',
  '/forwarding-addresses': 'Forwarding Addresses',
  '/fallback-addresses': 'Fallback Addresses',
  '/settings': 'Settings',
  '/address-book': 'Address Book',
}

// Pages that are accessed from Settings and should include Settings in breadcrumb
const settingsSubpages = ['/address-book', '/forwarding-addresses', '/fallback-addresses']

export function BreadcrumbNav() {
  const location = useLocation()
  const pathname = location.pathname

  // Don't show breadcrumbs on dashboard pages
  if (pathname === '/' || pathname === '/dashboard') {
    return null
  }

  const currentPageLabel = routeLabels[pathname] || pathname
  const isSettingsSubpage = settingsSubpages.includes(pathname)

  return (
    <Breadcrumb className="mb-2">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/dashboard">Dashboard</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        {isSettingsSubpage && (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/settings">Settings</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        )}
        <BreadcrumbItem>
          <BreadcrumbPage>{currentPageLabel}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

