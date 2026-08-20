// ABOUTME: PaymentLinkQrCode — renders a scannable QR of a pay-via-link URL (qrcode.react QRCodeSVG).
// ABOUTME: Transparent background + currentColor foreground so it inherits the surrounding frost surface.

import { QRCodeSVG } from 'qrcode.react'
import styles from './PaymentLinkQrCode.module.css'

export interface PaymentLinkQrCodeProps {
  value: string
  label?: string
  className?: string
}

export function PaymentLinkQrCode({
  value,
  label = 'Payment link QR code',
  className,
}: PaymentLinkQrCodeProps) {
  return (
    <div
      className={[styles.root, className].filter(Boolean).join(' ')}
      role="img"
      aria-label={label}
    >
      <QRCodeSVG
        value={value}
        size={200}
        level="M"
        className={styles.qr}
        bgColor="transparent"
        fgColor="currentColor"
      />
    </div>
  )
}
