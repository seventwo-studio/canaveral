// Windows-only private bridge. ABI and runtime acceptance require an approved guest.
using System;
using System.IO;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
namespace Canaveral.Windows {
public static class NativeBridge {
  static readonly Dictionary<string,IntPtr> files = new Dictionary<string,IntPtr>();
  static readonly Dictionary<string,AutomationElement> elements = new Dictionary<string,AutomationElement>();
  static readonly object outputLock = new object();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 6295552, RecursionLimit = 100 };
  static Stream input, output;
  static Terminal terminal;
  [StructLayout(LayoutKind.Sequential)] struct US { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OA { public uint Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Security, Qos; }
  [StructLayout(LayoutKind.Sequential)] struct IOS { public IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)] struct ID { public ulong Volume; public ulong Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Created, Accessed, Written, Changed; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct Standard { public long Allocation, Size; public uint Links; public byte Delete, Directory; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr handle,uint access,ref OA oa,out IOS io,IntPtr allocation,uint attributes,uint share,uint disposition,uint options,IntPtr ea,uint length);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr handle,out IOS io,IntPtr data,uint length,int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr h,int kind,IntPtr data,uint size);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool ReadFile(IntPtr h,byte[] bytes,uint length,out uint count,IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool WriteFile(IntPtr h,byte[] bytes,uint length,out uint count,IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool SetFilePointerEx(IntPtr h,long offset,IntPtr position,uint origin);
  [DllImport("kernel32.dll")] static extern bool FlushFileBuffers(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool CloseHandle(IntPtr h);
  internal static void Check(bool ok) { if(!ok) throw new IOException("Native operation refused"); }
  static Dictionary<string,object> D(params object[] pairs) { var d = new Dictionary<string,object>(); for(int i=0;i<pairs.Length;i+=2)d.Add((string)pairs[i],pairs[i+1]); return d; }
  static string S(Dictionary<string,object> a,string k) { return (string)a[k]; }
  static int N(Dictionary<string,object> a,string k) { return Convert.ToInt32(a[k]); }
  static long L(Dictionary<string,object> a,string k) { return Convert.ToInt64(a[k]); }
  static string Keep(IntPtr h) { Check(h!=IntPtr.Zero && h!=new IntPtr(-1)); string id=Guid.NewGuid().ToString(); files.Add(id,h); return id; }
  static IntPtr H(Dictionary<string,object> a) { return files[S(a,"handle")]; }
  static T Info<T>(IntPtr h,int kind) { int size=Marshal.SizeOf(typeof(T)); IntPtr p=Marshal.AllocHGlobal(size); try { Check(GetFileInformationByHandleEx(h,kind,p,(uint)size)); return (T)Marshal.PtrToStructure(p,typeof(T)); } finally { Marshal.FreeHGlobal(p); } }
  static void Component(string name) { Check(!String.IsNullOrEmpty(name) && name!="." && name!=".." && name.IndexOfAny(new char[]{'\\','/',':','\0'})<0 && !name.EndsWith(".") && !name.EndsWith(" ") && Encoding.Unicode.GetByteCount(name)<=65532); foreach(char c in name)Check(c>=32); }
  static IntPtr Relative(IntPtr parent,string name,bool directory,int mode) {
    Component(name); IntPtr raw=Marshal.StringToHGlobalUni(name), str=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));
    try { US u=new US { Length=(ushort)(name.Length*2), MaximumLength=(ushort)(name.Length*2), Buffer=raw }; Marshal.StructureToPtr(u,str,false);
      OA oa=new OA { Length=(uint)Marshal.SizeOf(typeof(OA)), Root=parent, Name=str, Attributes=0x40 }; IOS io; IntPtr h;
      uint access=mode==0?0x100081u:mode==1?0xC0110000u:0xC0100000u;
      int status=NtCreateFile(out h,access,ref oa,out io,IntPtr.Zero,mode==1?0x80u:0u,mode==0?1u:0u,mode==1?2u:1u,mode==0?(0x200020u|(directory?1u:0x40u)):0x200062u,IntPtr.Zero,0);
      Check(status>=0 && h!=IntPtr.Zero); return h;
    } finally { Marshal.FreeHGlobal(str); Marshal.FreeHGlobal(raw); }
  }
  static object FileCommand(string op, Dictionary<string,object> a) {
    if(op=="drive") { string drive=S(a,"drive"); Check(drive.Length==2 && drive[1]==':' && Char.IsLetter(drive[0]) && drive[0]<128); return Keep(CreateFileW(@"\\?\"+drive+@"\",0x100081,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero)); }
    if(op=="open" || op=="create" || op=="journal")return Keep(Relative(files[S(a,"parent")],S(a,"name"),op=="open"&&(bool)a["directory"],op=="open"?0:op=="create"?1:2));
    if(op=="exists") {
      // OPEN_REPARSE_POINT inspects the name itself, including dangling links.
      string name=S(a,"name");Component(name);IntPtr raw=Marshal.StringToHGlobalUni(name),str=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));
      try {
        US u=new US{Length=(ushort)(name.Length*2),MaximumLength=(ushort)(name.Length*2),Buffer=raw};Marshal.StructureToPtr(u,str,false);
        OA oa=new OA{Length=(uint)Marshal.SizeOf(typeof(OA)),Root=files[S(a,"parent")],Name=str,Attributes=0x40};IOS io;IntPtr opened;
        int status=NtCreateFile(out opened,0x100080,ref oa,out io,IntPtr.Zero,0,7,1,0x200020,IntPtr.Zero,0);
        if(status==unchecked((int)0xC0000034)||status==unchecked((int)0xC000003A))return false;
        Check(status>=0&&opened!=IntPtr.Zero);
        string owned=Keep(opened);Check(CloseHandle(opened));files.Remove(owned);return true;
      } finally {Marshal.FreeHGlobal(str);Marshal.FreeHGlobal(raw);}
    }
    IntPtr h=H(a);
    if(op=="close") { Check(CloseHandle(h)); files.Remove(S(a,"handle")); return true; }
    if(op=="info") { Check(GetFileType(h)==1); ID id=Info<ID>(h,18); Basic basic=Info<Basic>(h,0); Standard st=Info<Standard>(h,1); Check((basic.Attributes&0x440)==0 && st.Delete==0 && st.Size>=0 && st.Size<=9007199254740991L); byte[] native=new byte[16]; Buffer.BlockCopy(BitConverter.GetBytes(id.Low),0,native,0,8);Buffer.BlockCopy(BitConverter.GetBytes(id.High),0,native,8,8); return D("volume",id.Volume.ToString(),"fileId",BitConverter.ToString(native).Replace("-","").ToLowerInvariant(),"size",st.Size,"written",basic.Written.ToString(),"changed",basic.Changed.ToString(),"links",st.Links,"directory",st.Directory!=0,"attributes",basic.Attributes); }
    if(op=="read" || op=="write") { long offset=L(a,"offset");Check(offset>=0 && offset<=9007199254740991L); Check(SetFilePointerEx(h,offset,IntPtr.Zero,0)); uint count;
      if(op=="read") { int length=N(a,"count"); Check(length>=0&&length<=524288); byte[] bytes=new byte[length];Check(ReadFile(h,bytes,(uint)length,out count,IntPtr.Zero));return Convert.ToBase64String(bytes,0,(int)count); }
      byte[] data=Convert.FromBase64String(S(a,"data")); Check(data.Length<=524288);Check(WriteFile(h,data,(uint)data.Length,out count,IntPtr.Zero)); return count;
    }
    if(op=="flush") { Check(FlushFileBuffers(h)); return true; }
    if(op=="discard" || op=="publish" || op=="publishOwned") {
      int length=1; byte[] bytes;
      if(op=="discard") bytes=new byte[]{1}; else { string name=S(a,"name");Component(name); byte[] encoded=Encoding.Unicode.GetBytes(name);length=20+encoded.Length;bytes=new byte[Math.Max(24,length)];Buffer.BlockCopy(BitConverter.GetBytes(op=="publish"||(bool)a["replace"]?1u:0u),0,bytes,0,4);if(op=="publishOwned")Buffer.BlockCopy(BitConverter.GetBytes(files[S(a,"parent")].ToInt64()),0,bytes,8,8);Buffer.BlockCopy(BitConverter.GetBytes(encoded.Length),0,bytes,16,4);Buffer.BlockCopy(encoded,0,bytes,20,encoded.Length);length=bytes.Length; }
      IntPtr raw=Marshal.AllocHGlobal(length);try { Marshal.Copy(bytes,0,raw,length);IOS io;int status=NtSetInformationFile(h,out io,raw,(uint)length,op=="discard"?13:10);if(op=="publishOwned"&&status==unchecked((int)0xC0000035))return "exists";Check(status>=0);return op=="publishOwned"?(object)"published":true; } finally { Marshal.FreeHGlobal(raw); }
    }
    if(op=="entries") {
      IntPtr raw=Marshal.AllocHGlobal(65536);try { if(!GetFileInformationByHandleEx(h,(bool)a["first"]?20:19,raw,65536)) { Check(Marshal.GetLastWin32Error()==18);return D("entries",new object[0],"done",true); }
        byte[] bytes=new byte[65536];Marshal.Copy(raw,bytes,0,bytes.Length);var entries=new List<object>();int offset=0;
        while(true) { Check(offset+88<=bytes.Length);int next=BitConverter.ToInt32(bytes,offset), nameBytes=BitConverter.ToInt32(bytes,offset+60);Check(nameBytes>0 && nameBytes%2==0 && offset+88+nameBytes<=bytes.Length && (next==0 || next%8==0 && next>=88+nameBytes && offset+next<=bytes.Length));string name=new UnicodeEncoding(false,false,true).GetString(bytes,offset+88,nameBytes);uint attributes=BitConverter.ToUInt32(bytes,offset+56);long size=BitConverter.ToInt64(bytes,offset+40); Check(size>=0 && name.IndexOf('\0')<0);
          if(name!="."&&name!="..")entries.Add(D("name",name,"kind",(attributes&0x400)!=0?"symlink":(attributes&0x10)!=0?"directory":"file","size",size,"modifiedAt",BitConverter.ToInt64(bytes,offset+24)/10000000.0-11644473600,"attributes",attributes,"reparseTag",BitConverter.ToUInt32(bytes,offset+68),"nativeFileId",BitConverter.ToString(bytes,offset+72,16).Replace("-","").ToLowerInvariant()));
          if(next==0)break;offset+=next;
        }return D("entries",entries,"done",false);
      } finally { Marshal.FreeHGlobal(raw); }
    }
    throw new InvalidOperationException();
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr pid);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern short VkKeyScanExW(char c,IntPtr layout);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyExW(uint vk,uint mode,IntPtr layout);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int ToUnicodeEx(uint vk,uint scan,byte[] state,StringBuilder result,int length,uint flags,IntPtr layout);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle,int index,IntPtr value,uint size,out uint required);
  [StructLayout(LayoutKind.Sequential)] struct Key { public ushort Vk,Scan;public uint Flags,Time;public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int X,Y; public uint Data,Flags,Time;public IntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Key Key;[FieldOffset(0)] public Mouse Mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint Kind;public Union Value; }
  [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] events,int size);
  static bool inputFenced=false;
  static IntPtr pendingDesktop=IntPtr.Zero,pendingDpi=IntPtr.Zero;
  static bool ReleaseDesktop(){try{if(pendingDesktop!=IntPtr.Zero){if(!CloseDesktop(pendingDesktop))return false;pendingDesktop=IntPtr.Zero;}if(pendingDpi!=IntPtr.Zero){if(SetThreadDpiAwarenessContext(pendingDpi)==IntPtr.Zero)return false;pendingDpi=IntPtr.Zero;}return true;}catch{return false;}}
  static int[] Geometry() { int[] b={GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(78),GetSystemMetrics(79)};Check(b[2]>0&&b[2]<=4096&&b[3]>0&&b[3]<=4096);return b; }
  static string ObjectName(IntPtr h) { Check(h!=IntPtr.Zero);IntPtr p=Marshal.AllocHGlobal(1024);try { uint need;Check(GetUserObjectInformationW(h,2,p,1024,out need)&&need>0&&need<=1024);return Marshal.PtrToStringUni(p).ToLowerInvariant(); }finally{Marshal.FreeHGlobal(p);} }
  static void Active(IntPtr h) { IntPtr p=Marshal.AllocHGlobal(4);try{uint need;Check(GetUserObjectInformationW(h,6,p,4,out need)&&need==4&&Marshal.ReadInt32(p)!=0);}finally{Marshal.FreeHGlobal(p);} }
  static object DesktopContext(Func<object> work) {
    Check(pendingDesktop==IntPtr.Zero&&pendingDpi==IntPtr.Zero);IntPtr old=SetThreadDpiAwarenessContext(new IntPtr(-4)), desktop=IntPtr.Zero;Check(old!=IntPtr.Zero);pendingDpi=old;
    try { Check(ObjectName(GetProcessWindowStation())=="winsta0"&&ObjectName(GetThreadDesktop(GetCurrentThreadId()))=="default");desktop=OpenInputDesktop(0,false,1);Check(ObjectName(desktop)=="default");Active(desktop);object result=work();Active(desktop);return result; }
    finally { pendingDesktop=desktop;Check(ReleaseDesktop()); }
  }
  static object KeyCommand(string op,Dictionary<string,object> a) {
    if(op=="layout") { IntPtr window=GetForegroundWindow();uint thread=GetWindowThreadProcessId(window,IntPtr.Zero);IntPtr layout=GetKeyboardLayout(thread);Check(window!=IntPtr.Zero&&thread!=0&&layout!=IntPtr.Zero);return new object[]{window.ToInt64().ToString(),thread,layout.ToInt64().ToString()}; }
    IntPtr token=new IntPtr(Int64.Parse(S(a,"layout")));
    if(op=="scan")return MapVirtualKeyExW((uint)N(a,"vk"),4,token);
    if(op=="map")return VkKeyScanExW(S(a,"character")[0],token);
    if(op=="translate") { byte[] state=new byte[256];int mods=N(a,"modifiers");if((mods&1)!=0)state[16]=128;if((mods&2)!=0)state[17]=128;if((mods&4)!=0)state[18]=128;var result=new StringBuilder(8);int count=ToUnicodeEx((uint)N(a,"vk"),(uint)N(a,"scan"),state,result,8,4,token);return count==1?result.ToString():""; }
    throw new InvalidOperationException();
  }
  static object DesktopCommand(string op,Dictionary<string,object> a) {
    if(op=="close")return ReleaseDesktop();
    return DesktopContext(delegate {
      if(op=="geometry")return Geometry();
      if(op=="capture") { int[] b=Geometry();using(var bitmap=new Bitmap(b[2],b[3],PixelFormat.Format32bppRgb)) {using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(b[0],b[1],0,0,new Size(b[2],b[3]),CopyPixelOperation.SourceCopy|CopyPixelOperation.CaptureBlt);Check(EqualBounds(b,Geometry()));using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);Check(stream.Length<4194304);return D("bounds",b,"png",Convert.ToBase64String(stream.ToArray()));}} }
      if(op=="post") {
        bool cleanup=(bool)a["cleanup"];Check(cleanup||!inputFenced);if(!cleanup)Check(EqualBounds(Geometry(),(object[])a["bounds"]));object[] raw=(object[])a["events"];Check(raw.Length>0&&raw.Length<=4096);Input[] events=new Input[raw.Length];
        for(int i=0;i<raw.Length;i++){var e=(Dictionary<string,object>)raw[i];uint flags=Convert.ToUInt32(e["flags"]);if(S(e,"kind")=="key") {Check(!cleanup||(flags&2)!=0);events[i]=new Input{Kind=1,Value=new Union{Key=new Key{Vk=(ushort)N(e,"vk"),Scan=(ushort)N(e,"scan"),Flags=flags}}};}else{Check(!cleanup||flags!=0&&(flags&~0x154u)==0);events[i]=new Input{Kind=0,Value=new Union{Mouse=new Mouse{X=N(e,"x"),Y=N(e,"y"),Data=unchecked((uint)L(e,"data")),Flags=flags}}};}}
        inputFenced=true;uint count=SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(Input)));Check(count==events.Length);if(!cleanup)Check(EqualBounds(Geometry(),(object[])a["bounds"]));if(!cleanup)inputFenced=false;return count;
      }throw new InvalidOperationException();
    });
  }
  static bool EqualBounds(int[] a,IList b){if(b.Count!=4)return false;for(int i=0;i<4;i++)if(a[i]!=Convert.ToInt32(b[i]))return false;return true;}
  static string KeepElement(AutomationElement element) {if(element==null)return null;string id=Guid.NewGuid().ToString();elements.Add(id,element);return id;}
  static string Label(string value,int maximum){return value==null?"":value.Substring(0,Math.Min(value.Length,maximum));}
  static object UIACommand(string op,Dictionary<string,object> a) {
    return DesktopContext(delegate {
      if(op=="clear"){elements.Clear();return true;}
      if(op=="root")return KeepElement(AutomationElement.RootElement);
      if(op=="same")return Automation.Compare(elements[S(a,"a")],elements[S(a,"b")]);
      AutomationElement element=elements[S(a,"element")];
      if(op=="first")return KeepElement(TreeWalker.ControlViewWalker.GetFirstChild(element));
      if(op=="next")return KeepElement(TreeWalker.ControlViewWalker.GetNextSibling(element));
      if(op=="invoke"){((InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern)).Invoke();return true;}
      if(op=="describe") {
        var p=element.Current;bool password=p.IsPassword;var rect=p.BoundingRectangle;
        bool invokable=(bool)element.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty);
        var props=D("runtimeId",element.GetRuntimeId(),"processId",p.ProcessId,"controlTypeId",p.ControlType.Id,"className",Label(p.ClassName,1024),"frameworkId",Label(p.FrameworkId,1024),"helpText",password?"":Label(p.HelpText,1024),"acceleratorKey",Label(p.AcceleratorKey,1024),"accessKey",Label(p.AccessKey,1024));
        if(!password&&(bool)element.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty)){var value=((ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern)).Current;props.Add("value",Label(value.Value,4096));props.Add("readOnly",value.IsReadOnly);}
        bool bounds=!rect.IsEmpty&& !Double.IsInfinity(rect.X)&&!Double.IsInfinity(rect.Y)&&!Double.IsNaN(rect.X)&&!Double.IsNaN(rect.Y);
        return D("role",Label(p.LocalizedControlType,1024),"name",password?"":Label(p.Name,1024),"identifier",Label(p.AutomationId,1024),"states",D("enabled",p.IsEnabled,"focused",p.HasKeyboardFocus,"focusable",p.IsKeyboardFocusable,"offscreen",p.IsOffscreen,"password",password),"actions",invokable&&p.IsEnabled&&!p.IsOffscreen&&!password&&bounds&&rect.Width>0&&rect.Height>0?new string[]{"invoke"}:new string[0],"bounds",bounds?D("x",rect.X,"y",rect.Y,"width",rect.Width,"height",rect.Height):null,"properties",props);
      }throw new InvalidOperationException();
    });
  }
  static byte[] ReadExact(int count){byte[] raw=new byte[count];int at=0;while(at<count){int n=input.Read(raw,at,count-at);if(n==0)throw new EndOfStreamException();at+=n;}return raw;}
  static void Reply(object value){byte[] body;lock(outputLock){body=Encoding.UTF8.GetBytes((new JavaScriptSerializer { MaxJsonLength = 6295552, RecursionLimit = 100 }).Serialize(value));Check(body.Length>0&&body.Length<=6295552);byte[] size=BitConverter.GetBytes(body.Length);if(BitConverter.IsLittleEndian)Array.Reverse(size);output.Write(size,0,4);output.Write(body,0,body.Length);output.Flush();}}
  static void Dispatch(Dictionary<string,object> req){string id=S(req,"id"),action=S(req,"action");var args=(Dictionary<string,object>)req["arguments"];bool effect=action=="uia.invoke"||action=="desktop.post"||action=="files.publish"||action=="files.publishOwned"||action=="files.exists"||action=="files.write"||action=="terminal.open"||action=="terminal.write"||action=="terminal.resize";
    try {object result;if(action.StartsWith("files."))result=FileCommand(action.Substring(6),args);else if(action.StartsWith("keys."))result=KeyCommand(action.Substring(5),args);else if(action.StartsWith("uia."))result=UIACommand(action.Substring(4),args);else if(action.StartsWith("desktop."))result=DesktopCommand(action.Substring(8),args);else if(action.StartsWith("terminal."))result=TerminalCommand(action.Substring(9),args);else throw new InvalidOperationException();Reply(D("id",id,"ok",true,"result",result));}
    catch {if(action=="desktop.post")inputFenced=true;Reply(D("id",id,"ok",false,"status",409,"code","worker_refused","outcome",effect?"unknown":null));}
  }
  public static void Serve(){input=Console.OpenStandardInput();output=Console.OpenStandardOutput();try{while(true){byte[] size=ReadExact(4);if(BitConverter.IsLittleEndian)Array.Reverse(size);int length=BitConverter.ToInt32(size,0);Check(length>0&&length<=1000000);var req=(Dictionary<string,object>)json.DeserializeObject(new UTF8Encoding(false,true).GetString(ReadExact(length)));Guid parsed;Check(req.Count==3&&Guid.TryParseExact(S(req,"id"),"D",out parsed));if(S(req,"action").StartsWith("terminal.")){var captured=req;Task.Run(delegate{Dispatch(captured);});}else Dispatch(req);}}catch(EndOfStreamException){}finally{if(terminal!=null)terminal.Close();foreach(IntPtr h in files.Values)CloseHandle(h);}}
  static object TerminalCommand(string op,Dictionary<string,object> a){
    if(op=="open"){lock(outputLock){Check(terminal==null);terminal=new Terminal(S(a,"session"),S(a,"executable"),(object[])a["argv"],S(a,"directory"));}terminal.Start(N(a,"cols"),N(a,"rows"));return D("session",terminal.Session);}
    Check(terminal!=null);if(op=="read")return terminal.Read(L(a,"offset"));if(op=="write")return D("written",terminal.Write(S(a,"text")));if(op=="resize"){terminal.Resize(N(a,"cols"),N(a,"rows"));return D("resized",true);}if(op=="close")return D("closed",terminal.Close());throw new InvalidOperationException();
  }
  sealed class Terminal {
    internal readonly string Session;readonly string executable,directory;readonly object[] argv;
    IntPtr job,inputRead,inputWrite,outputRead,outputWrite,console,process,thread;
    readonly object ringLock=new object(), inputLock=new object(), life=new object();readonly List<byte> ring=new List<byte>();long baseOffset;
    Thread reader;volatile bool readerDone=false,failed=false,fenced=false;bool started=false;
    [StructLayout(LayoutKind.Sequential)]struct Coord{public short X,Y;}
    [StructLayout(LayoutKind.Sequential)]struct Startup{public uint cb;public IntPtr reserved,desktop,title;public uint x,y,xSize,ySize,xChars,yChars,fill,flags;public ushort show,reserved2;public IntPtr reservedPtr,inHandle,outHandle,errHandle;}
    [StructLayout(LayoutKind.Sequential)]struct StartupEx{public Startup startup;public IntPtr attributes;}
    [StructLayout(LayoutKind.Sequential)]struct ProcessInfo{public IntPtr process,thread;public uint pid,tid;}
    [DllImport("kernel32.dll")]static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr sa,uint size);
    [DllImport("kernel32.dll")]static extern int CreatePseudoConsole(Coord size,IntPtr input,IntPtr output,uint flags,out IntPtr console);
    [DllImport("kernel32.dll")]static extern int ResizePseudoConsole(IntPtr console,Coord size);
    [DllImport("kernel32.dll")]static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CreateJobObjectW(IntPtr sa,string name);
    [DllImport("kernel32.dll")]static extern bool SetInformationJobObject(IntPtr job,int kind,byte[] info,uint size);
    [DllImport("kernel32.dll")]static extern bool QueryInformationJobObject(IntPtr job,int kind,byte[] info,uint size,IntPtr required);
    [DllImport("kernel32.dll")]static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll")]static extern bool InitializeProcThreadAttributeList(IntPtr data,uint count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll")]static extern bool UpdateProcThreadAttribute(IntPtr data,uint flags,IntPtr kind,IntPtr value,IntPtr size,IntPtr previous,IntPtr required);
    [DllImport("kernel32.dll")]static extern void DeleteProcThreadAttributeList(IntPtr data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool CreateProcessW(string executable,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string directory,ref StartupEx startup,out ProcessInfo process);
    [DllImport("kernel32.dll")]static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool belongs);
    [DllImport("kernel32.dll")]static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint wait);
    [DllImport("kernel32.dll")]static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    internal Terminal(string session,string exe,object[] arguments,string cwd){Session=session;executable=exe;argv=arguments;directory=cwd;}
    static string Quote(string s){var b=new StringBuilder("\"");int slashes=0;foreach(char c in s){if(c=='\\'){slashes++;continue;}if(c=='"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);b.Append('"');return b.ToString();}
    internal void Start(int cols,int rows){lock(life){Check(!started&&!fenced);started=true;try{
      Check(cols>=1&&cols<=500&&rows>=1&&rows<=500);job=CreateJobObjectW(IntPtr.Zero,null);Check(job!=IntPtr.Zero);byte[] limits=new byte[144];Buffer.BlockCopy(BitConverter.GetBytes(0x2000u),0,limits,16,4);Check(SetInformationJobObject(job,9,limits,(uint)limits.Length));
      Check(CreatePipe(out inputRead,out inputWrite,IntPtr.Zero,0));Check(CreatePipe(out outputRead,out outputWrite,IntPtr.Zero,0));Check(CreatePseudoConsole(new Coord{X=(short)cols,Y=(short)rows},inputRead,outputWrite,0,out console)>=0);
      reader=new Thread(Drain);reader.IsBackground=true;reader.Start();
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);Check(size.ToInt64()>0&&size.ToInt64()<=1048576);IntPtr attributes=Marshal.AllocHGlobal(size),jobs=Marshal.AllocHGlobal(IntPtr.Size);bool initialized=false;
      try{Check(InitializeProcThreadAttributeList(attributes,2,0,ref size));initialized=true;Marshal.WriteIntPtr(jobs,job);Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20016),console,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        var startup=new StartupEx{startup=new Startup{cb=(uint)Marshal.SizeOf(typeof(StartupEx))},attributes=attributes};var command=new StringBuilder();foreach(string arg in argv){if(command.Length>0)command.Append(' ');command.Append(Quote(arg));}Check(command.Length<=30000);ProcessInfo child;Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x80004,IntPtr.Zero,directory,ref startup,out child));process=child.process;thread=child.thread;
      }finally{if(initialized)DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(jobs);Marshal.FreeHGlobal(attributes);}
      bool belongs;Check(IsProcessInJob(process,job,out belongs)&&belongs);Check(ResumeThread(thread)!=0xffffffff);Release(ref inputRead);Release(ref outputWrite);
    }catch{fenced=true;throw;}}}
    void Drain(){try{while(true){byte[] data=new byte[4096];uint count;if(!ReadFile(outputRead,data,4096,out count,IntPtr.Zero)){int error=Marshal.GetLastWin32Error();if(error==109||error==232)break;throw new IOException();}if(count==0)break;lock(ringLock){for(int i=0;i<count;i++)ring.Add(data[i]);int excess=Math.Max(0,ring.Count-65536);if(excess>0){ring.RemoveRange(0,excess);baseOffset+=excess;}}}}catch{failed=fenced=true;}finally{readerDone=true;}}
    bool Empty(){if(job==IntPtr.Zero)return true;byte[] info=new byte[48];Check(QueryInformationJobObject(job,1,info,48,IntPtr.Zero));return BitConverter.ToUInt32(info,40)==0;}
    internal object Read(long offset){Check(started&&job!=IntPtr.Zero&&!failed&&offset>=0&&offset<=9007199254740991L);lock(ringLock){long end=baseOffset+ring.Count;Check(offset<=end);long begin=Math.Max(offset,baseOffset);byte[] data=ring.GetRange((int)(begin-baseOffset),(int)(end-begin)).ToArray();bool exited=readerDone&&Empty();object exit=null;uint code;if(exited&&process!=IntPtr.Zero&&WaitForSingleObject(process,0)==0){Check(GetExitCodeProcess(process,out code));exit=code;}return D("session",Session,"data",Convert.ToBase64String(data),"offset",end,"truncated",offset<baseOffset,"exited",exited,"exitCode",exit);}}
    internal int Write(string value){byte[] data=new UTF8Encoding(false,true).GetBytes(value);Check(data.Length<=16384&&value.IndexOf('\0')<0);if(!Monitor.TryEnter(inputLock))throw new IOException();try{Check(started&&!fenced&&inputWrite!=IntPtr.Zero);int sent=0;try{while(sent<data.Length){Check(!fenced);byte[] pending=new byte[data.Length-sent];Buffer.BlockCopy(data,sent,pending,0,pending.Length);uint count;Check(WriteFile(inputWrite,pending,(uint)pending.Length,out count,IntPtr.Zero)&&count>0&&count<=pending.Length);sent+=(int)count;}Check(!fenced);return sent;}catch{fenced=true;throw;}}finally{Monitor.Exit(inputLock);}}
    internal void Resize(int cols,int rows){if(!Monitor.TryEnter(inputLock))throw new IOException();try{Check(!fenced&&cols>=1&&cols<=500&&rows>=1&&rows<=500);try{Check(ResizePseudoConsole(console,new Coord{X=(short)cols,Y=(short)rows})>=0);Check(!fenced);}catch{fenced=true;throw;}}finally{Monitor.Exit(inputLock);}}
    void Release(ref IntPtr handle){if(handle!=IntPtr.Zero){Check(CloseHandle(handle));handle=IntPtr.Zero;}}
    internal bool Close(){fenced=true;if(!Monitor.TryEnter(life,2000))return false;try{try{if(!Empty()){Check(TerminateJobObject(job,1));var deadline=DateTime.UtcNow.AddSeconds(2);while(!Empty()){if(DateTime.UtcNow>=deadline)return false;Thread.Sleep(10);}}if(!Monitor.TryEnter(inputLock,2000))return false;try{if(reader==null||readerDone)Release(ref outputRead);if(console!=IntPtr.Zero){ClosePseudoConsole(console);console=IntPtr.Zero;}Release(ref outputWrite);if(reader!=null&&!reader.Join(2000))return false;Release(ref outputRead);Release(ref inputRead);Release(ref inputWrite);Release(ref thread);Release(ref process);Release(ref job);return true;}finally{Monitor.Exit(inputLock);}}catch{return false;}}finally{Monitor.Exit(life);}}
  }
}
}
