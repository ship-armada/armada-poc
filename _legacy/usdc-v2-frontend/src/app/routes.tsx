import { lazy } from 'react'
import type { RouteObject } from 'react-router-dom'
import { useRoutes } from 'react-router-dom'
import { App } from './App'

const DashboardPage = lazy(async () => ({
  default: (await import('@/pages/Dashboard')).Dashboard,
}))
const HistoryPage = lazy(async () => ({
  default: (await import('@/pages/History')).History,
}))
const SettingsPage = lazy(async () => ({
  default: (await import('@/pages/Settings')).Settings,
}))
const AddressBookPage = lazy(async () => ({
  default: (await import('@/pages/AddressBook')).AddressBook,
}))
const DebugPage = lazy(async () => ({
  default: (await import('@/pages/Debug')).Debug,
}))

const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'address-book', element: <AddressBookPage /> },
      { path: 'debug', element: <DebugPage /> },
    ],
  },
]

export function AppRoutes() {
  return useRoutes(routes)
}
