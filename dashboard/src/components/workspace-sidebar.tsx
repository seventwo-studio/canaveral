import {
  LogOut,
  ChevronsUpDown,
  Rocket,
  LayoutDashboard,
  Users,
  KeyRound,
  Activity,
  ChartColumn,
  ListOrdered,
  ScrollText,
  Settings,
  Library,
  Monitor,
  MonitorPlay,
  Server,
  Orbit,
  Layers,
  User,
  Sparkles,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
  useSidebar,
} from "./ui/sidebar";

export const destinations = {
  admin: {
    group: "Workspace",
    label: "Overview",
    href: "#admin",
    icon: LayoutDashboard,
    adminOnly: true,
  },
  machines: {
    group: "Workspace",
    label: "Machines",
    href: "#machines",
    icon: Monitor,
    adminOnly: false,
  },
  screens: {
    group: "Workspace",
    label: "Screens",
    href: "#screens",
    icon: MonitorPlay,
    adminOnly: false,
  },
  builds: {
    group: "Workspace",
    label: "Linux builds",
    href: "#builds",
    icon: Layers,
    adminOnly: false,
  },
  previews: {
    group: "Workspace",
    label: "Workspace previews",
    href: "#previews",
    icon: Rocket,
    adminOnly: false,
  },
  models: {
    group: "Workspace",
    label: "Models",
    href: "#models",
    icon: Sparkles,
    adminOnly: true,
  },
  templates: {
    group: "Machine sources",
    label: "Image library",
    href: "#images",
    icon: Library,
    adminOnly: false,
  },
  blueprints: {
    group: "Machine sources",
    label: "Machine blueprints",
    href: "#blueprints",
    icon: Layers,
    adminOnly: false,
  },
  hosts: {
    group: "Infrastructure",
    label: "Hosts",
    href: "#hosts",
    icon: Server,
    adminOnly: true,
  },
  orchestrators: {
    group: "Infrastructure",
    label: "Orchestrators",
    href: "#orchestrators",
    icon: Orbit,
    adminOnly: true,
  },
  system: {
    group: "Infrastructure",
    label: "System",
    href: "#system",
    icon: Activity,
    adminOnly: true,
  },
  queue: {
    group: "Infrastructure",
    label: "Queue",
    href: "#queue",
    icon: ListOrdered,
    adminOnly: true,
  },
  activity: {
    group: "Infrastructure",
    label: "Activity",
    href: "#activity",
    icon: ScrollText,
    adminOnly: true,
  },
  usage: {
    group: "Infrastructure",
    label: "Usage",
    href: "#usage",
    icon: ChartColumn,
    adminOnly: true,
  },
  users: {
    group: "Administration",
    label: "Users",
    href: "#admin/users",
    icon: Users,
    adminOnly: true,
  },
  "api-access": {
    group: "Administration",
    label: "API access",
    href: "#admin/tokens",
    icon: KeyRound,
    adminOnly: true,
  },
  configuration: {
    group: "Administration",
    label: "Configuration",
    href: "#configuration",
    icon: Settings,
    adminOnly: true,
  },
  account: {
    group: "Personal",
    label: "Account",
    href: "#account",
    icon: User,
    adminOnly: false,
  },
  tokens: {
    group: "Personal",
    label: "API tokens",
    href: "#tokens",
    icon: KeyRound,
    adminOnly: false,
  },
} as const;

export function WorkspaceSidebar({
  view,
  counts,
  user,
  onSignOut,
}: {
  view: keyof typeof destinations;
  counts: Record<string, number>;
  user: { username: string; role: "admin" | "user" };
  onSignOut: () => void;
}) {
  const { setOpenMobile, isMobile } = useSidebar();
  const links = Object.entries(destinations).filter(
    ([, entry]) => !entry.adminOnly || user.role === "admin",
  );
  const groups = [
    "Workspace",
    "Machine sources",
    "Infrastructure",
    "Administration",
  ];
  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="h-12 justify-center border-b border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="px-1 group-data-[collapsible=icon]:p-0!" asChild tooltip="Canaveral">
              <a
                href="#machines"
                aria-label="Canaveral machines"
                onClick={() => setOpenMobile(false)}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-sidebar-primary text-sidebar-primary-foreground">
                  <Rocket className="size-4" />
                </span>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="w-fit truncate font-display text-base font-semibold leading-tight tracking-tight text-foreground">
                    canaveral
                  </span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((label) => {
          const entries = links.filter(([, entry]) => entry.group === label);
          if (!entries.length) return null;
          return (
            <SidebarGroup key={label}>
              <SidebarGroupLabel className="text-xs font-medium text-muted-foreground">
                {label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <nav
                  aria-label={
                    label === "Workspace"
                      ? "Main navigation"
                      : label + " navigation"
                  }
                >
                  <SidebarMenu>
                    {entries.map(
                      ([key, { label: title, icon: Icon, href }]) => (
                        <SidebarMenuItem key={key}>
                          <SidebarMenuButton
                            asChild
                            isActive={view === key}
                            tooltip={title}
                            className="h-10 md:h-8"
                          >
                            <a
                              href={href}
                              aria-current={view === key ? "page" : undefined}
                              onClick={() => setOpenMobile(false)}
                            >
                              <Icon aria-hidden="true" />
                              <span>{title}</span>
                            </a>
                          </SidebarMenuButton>
                          {counts[key] !== undefined && (
                            <SidebarMenuBadge className="font-mono text-xs tabular-nums">
                              {counts[key]}
                            </SidebarMenuBadge>
                          )}
                        </SidebarMenuItem>
                      ),
                    )}
                  </SidebarMenu>
                </nav>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent"
                  tooltip={user.username}
                  isActive={view === "account" || view === "tokens"}
                  aria-label="Account menu"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted text-sm font-medium">
                    {user.username.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate text-sm">{user.username}</span>
                    <span className="text-xs text-muted-foreground">
                      {user.role === "admin" ? "Administrator" : "User"}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-56"
                side={isMobile ? "bottom" : "right"}
                align="end"
              >
                <DropdownMenuLabel>{user.username}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a
                    href="#account"
                    aria-current={view === "account" ? "page" : undefined}
                    onClick={() => setOpenMobile(false)}
                  >
                    Account
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href="#tokens"
                    aria-current={view === "tokens" ? "page" : undefined}
                    onClick={() => setOpenMobile(false)}
                  >
                    API tokens
                  </a>
                </DropdownMenuItem>
                {user.role === "admin" && (
                  <DropdownMenuItem asChild>
                    <a
                      href="#users"
                      aria-current={view === "users" ? "page" : undefined}
                      onClick={() => setOpenMobile(false)}
                    >
                      Users
                    </a>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={onSignOut}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
