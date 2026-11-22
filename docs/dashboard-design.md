# Dashboard screens and navigation

## Reference

Browserbase keeps the selected project and its five main destinations in a persistent rail: Overview, Sessions, Agents, Functions and Playground. Overview puts recent sessions above analytics. Each row shows status, a shortened ID and timing. Its bordered metric strip keeps the date range and refresh control near the numbers. [Browserbase overview](https://mobbin.com/screens/5999d971-3c12-4486-9f23-8ff1098139bc)

The Agents page keeps the same rail and header while the recent runs section moves from an empty state to a filterable table. It places the create action at the top right and the account control at the bottom left. [Empty runs](https://mobbin.com/screens/2e1ae846-ad05-4912-a921-162ddf87ae22) and [populated runs](https://mobbin.com/screens/91fff3d4-82a6-4d59-95bd-0da39f7d3d51)

The supplied release link requires a Mobbin login in the shared browser. The connector supplied individual Browserbase screens. Their membership in that specific release and the full release screen count are unverified. [Requested release](https://mobbin.com/apps/browserbase-web-1605b46c-b3e7-46e3-a6bb-eb0a74433f48/d24cfac2-0619-4e87-a964-946cf423d3cb/screens)

## Reading the reference

The Sessions list puts search in the header and filters directly above the results. Its column labels are small, quiet and left aligned. White rows have horizontal separators and no vertical grid. Pale green pills identify completed sessions, so a reader can scan the status column without reading every ID. The empty space below a short result set stays white. [Filtered sessions](https://mobbin.com/screens/c7cff77e-7495-45ca-9eac-5031fddb1650)

Overview uses enclosure selectively. Related metrics share an outline and internal dividers. Chart titles sit above their plots, which use dark marks and faint dashed guides. Routine actions such as Refresh are white, lightly outlined rectangles with small corner radii. The orange logo occupies a fraction of the screen. The selected navigation row uses gray. [Overview](https://mobbin.com/screens/5999d971-3c12-4486-9f23-8ff1098139bc) · [Analytics detail](https://mobbin.com/screens/8570db55-e4a2-477e-b541-0702b05e0649)

Settings narrows the reading width inside the same shell. In Preferences the label column stays still as field widths and values change. Usage groups four measurements in a two-by-two panel. Projects uses separate groups for the project and its plan, with whitespace between headings and light rules within each group. [Preferences](https://mobbin.com/screens/afed0e5d-556b-4298-a286-e8cf31a331de) · [Project usage](https://mobbin.com/screens/915737bd-69f9-46f2-9832-313521874332) · [Projects](https://mobbin.com/screens/47c2c738-eafa-44d4-8f0b-dcdcab087b40)

The invite dialog sits on a light, blurred backdrop. Its fields and section titles align left, and its primary action fills the available width. Canaveral uses a darker orange for positive form submissions to keep small white labels legible, and preserves distinct Cancel and destructive actions where an operation needs confirmation. [Invite members](https://mobbin.com/screens/34f504f8-87cd-4dcf-b5b6-9459cd121b39)

Filter menus open beside their trigger with a fine outline, short rows and a soft shadow. Gray marks the highlighted row; the access picker also marks the selected value with an orange check. [Session filter](https://mobbin.com/screens/b633730a-9656-4a4e-8721-76845ed05684) · [Access picker](https://mobbin.com/screens/1e700e78-6640-4f99-80a6-48f56ddb6f15)

Recent Runs centers a bare inbox icon and a short caption in an empty section. Invocations keeps its column labels and places the empty message along the left edge of the list. Use the section treatment for first use and the inline treatment for a filtered list. Show loading and failed reads separately. [Recent Runs](https://mobbin.com/screens/d3576662-8006-471e-bd1b-7d48e938e2a8) · [Invocations](https://mobbin.com/screens/1ca1bac4-ad5b-4dc6-b7e0-71b41470c5fe)

## Canaveral implementation specification

These dimensions and colors are Canaveral implementation values chosen from visual comparison. The reference captures do not expose Browserbase’s CSS.

| Element | Treatment |
| --- | --- |
| Shell | Desktop rail 256px wide, collapsed rail 48px, sticky header 48px high. The rail meets the canvas at a single vertical hairline. Use 16px horizontal content padding on phones and 24px on desktop. |
| Surface and ink | White canvas and panels, #f8f8f8 shell, #202020 main text, #666666 supporting text. Group content with whitespace first, then a single #e3e3e3 rule when adjacent regions need a boundary. |
| Identity and selection | Orange marks the product, the checked option in a picker, and a positive dialog submission. Active navigation has a flat #eaeaea fill with dark text. Use a 4px radius for the selected row. The top bar names the destination once; detail pages add a link back to the parent. |
| Typography | Use system sans for navigation, controls, table headers and prose. Use Geist Mono for machine IDs, code and technical values. Destination headings are 20px semibold. Draw attention with weight and position before increasing size. |
| Spacing | Use the 4px spacing scale. Keep an icon close to its label, give neighboring actions more space, and leave 16–24px between independent content groups. Allow narrow toolbars to wrap in reading order. |
| Controls | Keep button and field silhouettes rectangular with softly rounded corners. Use dark fill for the principal submit or create action, a light border for ordinary commands and a ghost treatment for low-emphasis row actions. Use a visible focus outline with clearance around the control. |
| Tables and metrics | Place muted column names on white, align names with their values and separate rows with 1px rules. Use tabular figures for comparable numbers. Put related summary values inside one divided strip and allow them to wrap on phones. |
| Status and danger | Use small tinted pills with readable state names. A dot can reinforce the label. Keep success green, waiting amber and failure red. Reserve destructive action styling for commands that warrant confirmation. |
| Sheets and dialogs | Keep the title, affected resource and decision in the same panel. Give overlays more elevation than inline panels. Constrain tall content to the viewport, preserve keyboard focus and expose controls at narrow widths. |

The Sessions list puts status first and separates rows with fine horizontal rules. On wide screens Machines follows that order. On phones the machine name leads each labeled record. Active search, state and owner filters are individually removable, and the inventory count appears once beneath the results. [Filtered Sessions](https://mobbin.com/screens/c7cff77e-7495-45ca-9eac-5031fddb1650)

For settings, keep related field labels and controls within one divided group. Put help text beside its field and keep it available to assistive technology. Native pickers use the same border, height and focus treatment as adjacent inputs. [Project settings](https://mobbin.com/screens/e984b51b-6945-46cf-8459-fbafff41fd52)

### Shared shadcn dimensions

| Primitive | Size and detail |
| --- | --- |
| Button | 24px extra-small, 28px small, 32px default and 40px large. Default horizontal padding is 12px or 10px with an icon. Use 13px medium-weight labels, 16px icons and 6px corners. |
| Input, select, toggle | Default height 32px. Editable text is 16px on small screens and 13px on desktop. Use a white selected segment on a neutral track with 2px padding. |
| Card | 16px padding and section gaps. Titles are 14px semibold, descriptions 13px with 20px line height. A hairline and small shadow separate panels on white. |
| Table | 36px header, 44px minimum data rows, 12px horizontal padding. Set muted headings at 12px and data at 13px. Allow multiline resource details to increase row height. |
| Badge | A 20px pill with 6px horizontal padding. Keep neutral labels quiet and pair domain color with a written state. |

### Page layouts

The Machines and Orchestrators lists keep creation actions in the sticky destination header. The Machines list uses horizontal rules on wide screens and labeled rows on phones. Overview opens with the attention list, then groups fleet state and host reservations in one panel. Account and API tokens use a 672px reading area. Editable settings share one outlined group with horizontal row dividers. At a form width of 512px, each row puts its label and control in equal columns. Narrower groups stack each label above its control. Place the submit action beneath the group at its trailing edge.

| Other destinations | Layout |
| --- | --- |
| Activity, queue and system | Put filters and refresh near the list. Use horizontal rules between events, requests and leases. Keep the position or state visible beside the record; allow identifiers to wrap separately. |
| Usage and host resources | Group related totals in a divided panel. Neutral chart segments have matching labels and values. Reservations and measured usage have separate sections. |
| Hosts, images and blueprints | On wide screens place catalogue entries in full-width rows with aligned actions. Use cards at narrower widths. Within a host, use ruled lists for machines, images and reservations. Align form controls in import, setup and maintenance dialogs with the shared input height. |
| Users, API access and configuration | Keep filters with their results. Group the feature and action selectors above operation fields. Separate confirmation controls from the operation summary with a rule. |
| Builds, previews and models | Group launch controls together. Give queue entries and results distinct sections, with technical identifiers and output in monospace. |
| Screen wall and machine control | Keep device labels and actions beside their viewports. Use compact headers for files, terminal and inspection tools. Preserve the usable area of live displays and keep session controls accessible on phones. |

Forms use 16px between fields and 6px between a label and its control. Dialog headings align left. A horizontal rule and 12px of top padding separate footer actions from content. The overlay darkens the workspace while leaving its context visible.

## Canaveral screen map

| Entry | Destination | Next steps |
| --- | --- | --- |
| Signed out | Sign in | Enter the machine workspace. An invitation or recovery link opens the password claim form. |
| Workspace | Overview (`#admin`, administrators) | Inspect machines needing attention, review fleet and access counts, or open an operational destination. |
| Workspace | Machines (`#machines`) | Filter the fleet, create a machine, inspect details, start or control an eligible machine. Capture and power-off actions open against the selected machine. |
| Workspace | Screens (`#screens`) | Choose up to four running, account-owned mobile devices and watch them live side by side. Open a device's control from its tile. `#screens/<uuid>+<uuid>` names the devices on the wall. |
| Machine control | Selected machine | Use the available display, input, accessibility, file and terminal tools. A headless machine can expose files and terminals without a display connection. |
| Machine sources | Image library (`#images`) | Search downloaded artifacts, inspect provenance and open a blueprint from a source. Administrators can open the registry, import images and inspect image activity. |
| Machine sources | Machine blueprints (`#blueprints`) | Inspect immutable revisions and create a machine from an eligible offer. Administrators can create blueprints and revisions. |
| Infrastructure, administrators | Hosts (`#hosts`) and Orchestrators (`#orchestrators`) | Connect a runner or open a named resource at `#hosts/<id>` or `#orchestrators/<id>`. Inspect resource reports, limits and inventory, then return to the parent list. |
| Infrastructure, administrators | System (`#system`) | Inspect applications, leases, waiting requests, jobs, operations and access sessions. Leases show their holder's label and the time remaining. |
| Infrastructure, administrators | Queue (`#queue`) | Read the waiting requests in attempt order with position and the reason each waits, and the leases that hold capacity. Cancel a named request, or open the events of a request, lease or application. |
| Infrastructure, administrators | Activity (`#activity`) | Follow the event log live, filter by family, kind, attention, application, host or lease, and load older events. `#activity/<subject>/<uuid>` opens it on one application, lease, request, host or machine. |
| Infrastructure, administrators | Usage (`#usage`) | Choose a range and a grouping, read requests by outcome, waits, leases, held device time and failures, and download the CSV. |
| Administration | Users (`#admin/users`) | Search accounts, invite a user, initiate recovery or confirm a role or status change. |
| Administration | API access (`#admin/tokens`) | Inspect token ownership, permissions and expiry. Confirm revocation for a named token. |
| Administration | Configuration (`#configuration`) | Select a named administrative API action and review its fields and result. |
| Account menu | Account (`#account`), API tokens (`#tokens`), sign out | Change the signed-in user's password or manage their personal tokens. |

The image library also accepts `#templates`, user administration accepts `#users`, and infrastructure details accept the older `/<id>/resources` suffix. See the [dashboard contract](dashboard.md) for access checks and recovery behavior.

## Design principles

- Give the operator a stable location. Keep resource families in the rail, account actions at its foot and the current destination in the sticky header. On small screens the rail becomes a drawer. Changing destinations scrolls to the top and moves keyboard focus to the workspace.
- Use a white work area and a pale neutral navigation rail. Use orange sparingly for identity and action, and use monospace for identifiers and measurements. Keep the launch photograph on the account entry screens.
- Give each machine an action appropriate to its state. Keep its name and status visible while the operator inspects details. On narrow screens, pair each value with its label.
- Keep fleet health compact so search, filters and the first machine are visible together on a narrow phone. Use a full-width search input and a native state picker on phones. Keep host reservations expandable and label fleet counts as applying before filters.
- Lead Overview with up to four actionable exceptions. When machines and connections both need attention, include at least one of each in the preview. Put fleet and host health before account administration, with one refresh action for the whole overview.
- Show where a number came from. Keep reservations distinct from measured consumption, label stale snapshots and surface missing measurements where a value would appear.
- Bind consequential actions to their subject. Name the affected machine, account or token in confirmations. A failed read offers a refresh. An uncertain operation offers status recovery using the original request identity.
- Say what a number is where it is shown. A queue position is an order of attempts, not a promise. Device time is held lease time, not measured utilisation. A percentile names its sample count, and no sample reads as "No samples", not zero. Count time against the controller's clock when it sent one.
- Keep long identifiers on a line of their own below the short figures, so a UUID is not broken across a narrow column. On phones, fold filters that are rarely used so the first row of content stays near the top.
