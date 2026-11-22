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
  SidebarTrigger,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
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
      <SidebarHeader className="h-12 flex-row items-center justify-between border-b border-sidebar-border pr-12 md:pr-2 group-data-[collapsible=icon]:justify-center">
        <SidebarMenuButton
          className="w-auto min-w-0 gap-2.5 px-1 group-data-[collapsible=icon]:hidden"
          asChild
        >
          <a
            href="#machines"
            aria-label="Canaveral machines"
            onClick={() => setOpenMobile(false)}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-sidebar-primary text-sidebar-primary-foreground">
              <Rocket className="size-4" aria-hidden="true" />
            </span>
            <span className="truncate text-sm font-semibold text-foreground">
              canaveral
            </span>
          </a>
        </SidebarMenuButton>
        <SidebarTrigger className="hidden shrink-0 text-muted-foreground md:inline-flex" />
      </SidebarHeader>
      <SidebarContent className="gap-0 py-2">
        {groups.map((label) => {
          const entries = links.filter(([, entry]) => entry.group === label);
          if (!entries.length) return null;
          return (
            <SidebarGroup
              key={label}
              className={
                label === "Administration" ? "mt-auto py-1.5" : "py-1.5"
              }
            >
              <SidebarGroupLabel className="h-7 font-normal text-muted-foreground group-data-[collapsible=icon]:-mt-7">
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
                  <SidebarMenu className="gap-0.5 md:gap-0">
                    {entries.map(
                      ([key, { label: title, icon: Icon, href }]) => (
                        <SidebarMenuItem key={key}>
                          <SidebarMenuButton
                            asChild
                            isActive={view === key}
                            tooltip={title}
                            className="h-10 rounded-sm md:h-8 md:text-[13px]"
                          >
                            <a
                              href={href}
                              aria-label={title}
                              aria-describedby={
                                counts[key] === undefined
                                  ? undefined
                                  : `nav-count-${key}`
                              }
                              aria-current={view === key ? "page" : undefined}
                              onClick={() => setOpenMobile(false)}
                            >
                              <Icon aria-hidden="true" />
                              <span className="min-w-0 truncate">{title}</span>
                              {counts[key] !== undefined && (
                                <span
                                  id={`nav-count-${key}`}
                                  className="ml-auto shrink-0 pl-2 text-xs font-normal tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden"
                                >
                                  {counts[key]}
                                </span>
                              )}
                            </a>
                          </SidebarMenuButton>
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
                  className="h-10 rounded-sm md:h-8 data-[state=open]:bg-sidebar-accent group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
                  tooltip={user.username}
                  isActive={view === "account" || view === "tokens"}
                  aria-label="Account menu"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[10px] font-medium text-sidebar-foreground">
                    {user.username.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-[13px] group-data-[collapsible=icon]:hidden">
                    {user.username}
                  </span>
                  <ChevronsUpDown
                    className="size-3.5 text-muted-foreground group-data-[collapsible=icon]:hidden"
                    aria-hidden="true"
                  />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-56"
                side={isMobile ? "bottom" : "right"}
                align="end"
              >
                <DropdownMenuLabel className="grid gap-0.5">
                  <span className="break-all">{user.username}</span>
                  <span className="font-normal text-muted-foreground">
                    {user.role === "admin" ? "Administrator" : "User"}
                  </span>
                </DropdownMenuLabel>
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
