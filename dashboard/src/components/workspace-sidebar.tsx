import { LogOut, ChevronsUpDown, Rocket } from "lucide-react";
import type { LucideIcon } from "lucide-react";
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

export function WorkspaceSidebar({
  views,
  view,
  counts,
  user,
  onSignOut,
}: {
  views: Record<string, { icon: LucideIcon }>;
  view: string;
  counts: Record<string, number>;
  user: { username: string; role: "admin" | "user" };
  onSignOut: () => void;
}) {
  const { setOpenMobile, isMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Canaveral">
              <a
                href="#machines"
                aria-label="Canaveral machines"
                onClick={() => setOpenMobile(false)}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-sidebar-primary text-sidebar-primary-foreground">
                  <Rocket className="size-4" />
                </span>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="w-fit truncate font-display text-base font-medium leading-tight text-foreground">
                    canaveral
                  </span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-widest">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Main navigation">
              <SidebarMenu>
                {Object.entries(views).map(([key, { icon: Icon }]) => (
                  <SidebarMenuItem key={key}>
                    <SidebarMenuButton
                      asChild
                      isActive={view === key}
                      tooltip={
                        key === "templates"
                          ? "Images"
                          : key.charAt(0).toUpperCase() + key.slice(1)
                      }
                    >
                      <a
                        href={`#${key === "templates" ? "images" : key}`}
                        aria-current={view === key ? "page" : undefined}
                        onClick={() => setOpenMobile(false)}
                      >
                        <Icon aria-hidden="true" />
                        <span>
                          {key === "templates"
                            ? "Images"
                            : key.charAt(0).toUpperCase() + key.slice(1)}
                        </span>
                      </a>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>{counts[key]}</SidebarMenuBadge>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent"
                  tooltip={user.username}
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
                  <a href="#account">Account</a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="#tokens">API tokens</a>
                </DropdownMenuItem>
                {user.role === "admin" && (
                  <DropdownMenuItem asChild>
                    <a href="#users">Users</a>
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
