/**
 * Dedicated address book management page.
 */

import { BreadcrumbNav } from '@/components/common/BreadcrumbNav'
import { AddressBookManager } from '@/components/addressBook/AddressBookManager'

export function AddressBook() {
  return (
    <div className="container mx-auto p-12">
      <div className="mb-10">
        <BreadcrumbNav />
      </div>

      <div className="mx-auto">
        <AddressBookManager />
        <div className="min-h-12" />
      </div>
    </div>
  )
}

