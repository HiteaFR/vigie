import { Server, Network, House, Film, Activity, Globe, Shield, Code, Folder } from 'lucide-react'

// group icons declared in config.json (lucide names in kebab-case)
const ICONS = { server: Server, network: Network, house: House, film: Film, activity: Activity, globe: Globe, shield: Shield, code: Code }

export const groupIcon = name => ICONS[name] || Folder
