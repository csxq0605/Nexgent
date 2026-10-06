import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Nexgent application's mark at the host's requested size.
 * @param props - Host-supplied mark presentation.
 * @returns the Nexgent mark.
 */
export function NexgentBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Nexgent" role="img">
    <rect width="32" height="32" rx="8" fill="#236cff" />
    <path d="M9 24V8h3l8 11V8h3v16h-3L12 13v11Z" fill="white" />
  </svg>
}

/**
 * Render the Nexgent application's name independently from its mark.
 * @returns the Nexgent name.
 */
export function NexgentBrandName() {
  return <span style={{ fontWeight: 650, fontSize: 19 }}>Nexgent</span>
}

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}
