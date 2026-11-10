//! Dynamically loaded public libatspi/GLib ABI. No native library is loaded by portable tests.
//! Declarations and ownership follow GNOME at-spi2-core's public headers and introspection annotations.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use super::{Api, Bounds, Details};
use canaveral_guest_protocol::Result;
use libc::{c_char, c_int, c_void};
use serde_json::Value;
use std::{collections::BTreeMap, ffi::CStr, ptr};
type Ptr = *mut c_void;
type Error = *mut Ptr;
type GetString = unsafe extern "C" fn(Ptr, Error) -> *mut c_char;
type GetInt = unsafe extern "C" fn(Ptr, Error) -> c_int;
type GetObject = unsafe extern "C" fn(Ptr) -> Ptr;
type GetDouble = unsafe extern "C" fn(Ptr, Error) -> f64;
#[repr(C)]
struct GArray {
    data: *mut c_void,
    len: u32,
}
#[repr(C)]
struct EnumValue {
    value: c_int,
    name: *const c_char,
    nick: *const c_char,
}
#[repr(C)]
struct Rect {
    x: c_int,
    y: c_int,
    width: c_int,
    height: c_int,
}
struct Library(Ptr);
impl Library {
    fn load(name: &CStr) -> Result<Self> {
        let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return Err(format!(
                "required guest library unavailable: {}",
                name.to_string_lossy()
            )
            .into());
        }
        Ok(Self(handle))
    }
    unsafe fn symbol<T: Copy>(&self, name: &CStr) -> Result<T> {
        let pointer = libc::dlsym(self.0, name.as_ptr());
        if pointer.is_null() || std::mem::size_of::<T>() != std::mem::size_of::<Ptr>() {
            return Err(format!(
                "required native symbol unavailable: {}",
                name.to_string_lossy()
            )
            .into());
        }
        Ok(std::mem::transmute_copy(&pointer))
    }
}
// GObject registers static type callbacks into these libraries. Keep them loaded for the
// whole one-operation worker process; unloading them could leave dangling GType callbacks.
// Process exit reclaims the loader handles, including on partial symbol/init failure.
macro_rules! symbols {
    ($($field:ident : $ty:ty = $name:literal),* $(,)?) => {
        struct Symbols { $( $field: $ty, )* }
        impl Symbols {
            unsafe fn load(library: &Library) -> Result<Self> {
                Ok(Self { $( $field: library.symbol(CStr::from_bytes_with_nul_unchecked(concat!($name, "\0").as_bytes()))?, )* })
            }
        }
    }
}
symbols! {
    init: unsafe extern "C" fn() -> c_int = "atspi_init",
    timeout: unsafe extern "C" fn(c_int, c_int) = "atspi_set_timeout",
    desktop: unsafe extern "C" fn(c_int) -> Ptr = "atspi_get_desktop",
    clear: unsafe extern "C" fn(Ptr) = "atspi_accessible_clear_cache",
    cache: unsafe extern "C" fn(Ptr, c_int) = "atspi_accessible_set_cache_mask",
    role: GetString = "atspi_accessible_get_role_name",
    name: GetString = "atspi_accessible_get_name",
    description: GetString = "atspi_accessible_get_description",
    attributes: unsafe extern "C" fn(Ptr, Error) -> *mut GArray = "atspi_accessible_get_attributes_as_array",
    state_set: GetObject = "atspi_accessible_get_state_set",
    states: unsafe extern "C" fn(Ptr) -> *mut GArray = "atspi_state_set_get_states",
    state_type: unsafe extern "C" fn() -> usize = "atspi_state_type_get_type",
    child_count: GetInt = "atspi_accessible_get_child_count",
    child: unsafe extern "C" fn(Ptr, c_int, Error) -> Ptr = "atspi_accessible_get_child_at_index",
    action: GetObject = "atspi_accessible_get_action_iface",
    action_count: GetInt = "atspi_action_get_n_actions",
    action_name: unsafe extern "C" fn(Ptr, c_int, Error) -> *mut c_char = "atspi_action_get_action_name",
    invoke: unsafe extern "C" fn(Ptr, c_int, Error) -> c_int = "atspi_action_do_action",
    component: GetObject = "atspi_accessible_get_component_iface",
    bounds: unsafe extern "C" fn(Ptr, c_int, Error) -> *mut Rect = "atspi_component_get_extents",
    text: GetObject = "atspi_accessible_get_text_iface",
    text_count: GetInt = "atspi_text_get_character_count",
    text_read: unsafe extern "C" fn(Ptr, c_int, c_int, Error) -> *mut c_char = "atspi_text_get_text",
    value: GetObject = "atspi_accessible_get_value_iface",
    current: GetDouble = "atspi_value_get_current_value",
    minimum: GetDouble = "atspi_value_get_minimum_value",
    maximum: GetDouble = "atspi_value_get_maximum_value",
}
pub(super) struct Object {
    pointer: Ptr,
    unref: unsafe extern "C" fn(Ptr),
}
impl Drop for Object {
    fn drop(&mut self) {
        unsafe {
            (self.unref)(self.pointer);
        }
    }
}
struct ErrorSlot {
    pointer: Ptr,
    free: unsafe extern "C" fn(Ptr),
}
impl ErrorSlot {
    fn checked<T>(&self, value: T) -> Result<T> {
        if self.pointer.is_null() {
            Ok(value)
        } else {
            Err("AT-SPI D-Bus request failed".into())
        }
    }
}
impl Drop for ErrorSlot {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            unsafe {
                (self.free)(self.pointer);
            }
        }
    }
}
struct Array<'a> {
    pointer: *mut GArray,
    api: &'a Native,
    strings: bool,
}
impl Drop for Array<'_> {
    fn drop(&mut self) {
        unsafe {
            if self.strings && !(*self.pointer).data.is_null() {
                for i in 0..(*self.pointer).len as usize {
                    let value = ptr::read_unaligned((*self.pointer).data.cast::<Ptr>().add(i));
                    (self.api.free)(value);
                }
            }
            (self.api.array_unref)(self.pointer);
        }
    }
}
pub(super) struct Native {
    symbols: Symbols,
    free: unsafe extern "C" fn(Ptr),
    error_free: unsafe extern "C" fn(Ptr),
    unref: unsafe extern "C" fn(Ptr),
    array_unref: unsafe extern "C" fn(*mut GArray),
    class_ref: unsafe extern "C" fn(usize) -> Ptr,
    class_unref: unsafe extern "C" fn(Ptr),
    enum_value: unsafe extern "C" fn(Ptr, c_int) -> *const EnumValue,
    // Handles outlive all symbols and objects. Processes exit after one operation.
    _libraries: [Library; 3],
}
impl Native {
    pub(super) fn load() -> Result<Self> {
        // No call site may load a host library as an implicit production fallback.
        if !cfg!(target_os = "linux") {
            return Err("AT-SPI worker requires Linux".into());
        }
        unsafe {
            let atspi = Library::load(c"libatspi.so.0")?;
            let object = Library::load(c"libgobject-2.0.so.0")?;
            let glib = Library::load(c"libglib-2.0.so.0")?;
            let symbols = Symbols::load(&atspi)?;
            let api = Self {
                free: glib.symbol(c"g_free")?,
                error_free: glib.symbol(c"g_error_free")?,
                unref: object.symbol(c"g_object_unref")?,
                array_unref: glib.symbol(c"g_array_unref")?,
                class_ref: object.symbol(c"g_type_class_ref")?,
                class_unref: object.symbol(c"g_type_class_unref")?,
                enum_value: object.symbol(c"g_enum_get_value")?,
                symbols,
                _libraries: [atspi, object, glib],
            };
            (api.symbols.timeout)(200, 500);
            if (api.symbols.init)() != 0 {
                return Err("AT-SPI session bus unavailable".into());
            }
            Ok(api)
        }
    }
    fn error(&self) -> ErrorSlot {
        ErrorSlot {
            pointer: ptr::null_mut(),
            free: self.error_free,
        }
    }
    fn object(&self, pointer: Ptr) -> Result<Object> {
        if pointer.is_null() {
            return Err("native accessibility object unavailable".into());
        }
        Ok(Object {
            pointer,
            unref: self.unref,
        })
    }
    unsafe fn owned_string(&self, pointer: *mut c_char) -> Result<String> {
        if pointer.is_null() {
            return Err("native string unavailable".into());
        }
        let result = self.string(pointer);
        (self.free)(pointer.cast());
        result
    }
    unsafe fn string(&self, pointer: *const c_char) -> Result<String> {
        if pointer.is_null() {
            return Err("native string unavailable".into());
        }
        let size = libc::strnlen(pointer, 65537);
        if size > 65536 {
            return Err("native string exceeded bound".into());
        }
        Ok(std::str::from_utf8(std::slice::from_raw_parts(pointer.cast(), size))?.to_owned())
    }
    fn get_string(&self, object: Ptr, function: GetString) -> Result<String> {
        let mut error = self.error();
        let pointer = unsafe { function(object, &mut error.pointer) };
        let value = unsafe { self.owned_string(pointer) };
        error.checked(value?)
    }
    fn get_int(&self, object: Ptr, function: GetInt) -> Result<i32> {
        let mut error = self.error();
        let value = unsafe { function(object, &mut error.pointer) };
        error.checked(value)
    }
    fn get_double(&self, object: Ptr, function: GetDouble) -> Result<Value> {
        let mut error = self.error();
        let value = unsafe { function(object, &mut error.pointer) };
        error.checked(())?;
        if !value.is_finite() {
            return Err("nonfinite native value".into());
        }
        Ok(serde_json::json!(value))
    }
    fn array(&self, pointer: *mut GArray, strings: bool) -> Result<Array<'_>> {
        if pointer.is_null() {
            return Err("native array unavailable".into());
        }
        let array = Array {
            pointer,
            api: self,
            strings,
        };
        let len = unsafe { (*pointer).len };
        if len > 1024 || (len > 0 && unsafe { (*pointer).data.is_null() }) {
            return Err("native array exceeded bound".into());
        }
        Ok(array)
    }
    fn attributes(&self, object: Ptr) -> Result<BTreeMap<String, Value>> {
        let mut error = self.error();
        let pointer = unsafe { (self.symbols.attributes)(object, &mut error.pointer) };
        let array = self.array(pointer, true)?;
        error.checked(())?;
        let mut properties = BTreeMap::new();
        unsafe {
            for i in 0..(*array.pointer).len as usize {
                let pointer =
                    ptr::read_unaligned((*array.pointer).data.cast::<*const c_char>().add(i));
                let attribute = self.string(pointer)?;
                if let Some((key, value)) = attribute.split_once(':') {
                    properties.insert(key.to_owned(), Value::String(value.to_owned()));
                }
            }
        }
        Ok(properties)
    }
    fn states(&self, object: Ptr) -> Result<Vec<String>> {
        let state_set = self.object(unsafe { (self.symbols.state_set)(object) })?;
        let array = self.array(unsafe { (self.symbols.states)(state_set.pointer) }, false)?;
        let class = unsafe { (self.class_ref)((self.symbols.state_type)()) };
        if class.is_null() {
            return Err("native state enumeration unavailable".into());
        }
        let result = (|| -> Result<_> {
            let mut states = Vec::new();
            unsafe {
                for i in 0..(*array.pointer).len as usize {
                    let index = ptr::read_unaligned((*array.pointer).data.cast::<c_int>().add(i));
                    let value = (self.enum_value)(class, index);
                    if value.is_null() {
                        return Err("unknown native state".into());
                    }
                    let name = self.string((*value).name)?;
                    states.push(
                        name.strip_prefix("ATSPI_STATE_")
                            .unwrap_or(&name)
                            .to_lowercase(),
                    );
                }
            }
            Ok(states)
        })();
        unsafe {
            (self.class_unref)(class);
        }
        result
    }
    fn action_names(&self, object: Ptr) -> Result<(Object, Vec<String>)> {
        let iface = self.object(unsafe { (self.symbols.action)(object) })?;
        let count = self.get_int(iface.pointer, self.symbols.action_count)?;
        if !(0..=128).contains(&count) {
            return Err("native action count exceeded".into());
        }
        let mut names = Vec::new();
        for i in 0..count {
            let mut error = self.error();
            let pointer =
                unsafe { (self.symbols.action_name)(iface.pointer, i, &mut error.pointer) };
            let name = unsafe { self.owned_string(pointer) }?;
            names.push(error.checked(name)?);
        }
        Ok((iface, names))
    }
}
impl Api for Native {
    type Handle = Object;
    fn desktop(&self) -> Result<Object> {
        self.object(unsafe { (self.symbols.desktop)(0) })
    }
    fn describe(&self, object: &Object) -> Result<Details> {
        let pointer = object.pointer;
        // Never accept cached metadata for revalidation. This includes the child/path cache.
        unsafe {
            (self.symbols.cache)(pointer, 0);
            (self.symbols.clear)(pointer);
        }
        let role = self.get_string(pointer, self.symbols.role)?;
        let name = self.get_string(pointer, self.symbols.name)?;
        let states = self.states(pointer)?;
        if states.iter().any(|state| state == "defunct") {
            return Err("native accessibility object is defunct".into());
        }
        let mut properties = self.attributes(pointer)?;
        if !role.to_lowercase().contains("password") && !states.iter().any(|s| s == "protected") {
            if let Ok(text) = self.object(unsafe { (self.symbols.text)(pointer) }) {
                if let Ok(count) = self.get_int(text.pointer, self.symbols.text_count) {
                    let mut error = self.error();
                    let raw = unsafe {
                        (self.symbols.text_read)(
                            text.pointer,
                            0,
                            count.clamp(0, 4096),
                            &mut error.pointer,
                        )
                    };
                    let value = unsafe { self.owned_string(raw) };
                    if let Ok(value) = value.and_then(|v| error.checked(v)) {
                        properties.insert("text".into(), value.into());
                    }
                }
            }
            if let Ok(value) = self.object(unsafe { (self.symbols.value)(pointer) }) {
                if let (Ok(current), Ok(minimum), Ok(maximum)) = (
                    self.get_double(value.pointer, self.symbols.current),
                    self.get_double(value.pointer, self.symbols.minimum),
                    self.get_double(value.pointer, self.symbols.maximum),
                ) {
                    properties.insert("value".into(), current);
                    properties.insert("minimum".into(), minimum);
                    properties.insert("maximum".into(), maximum);
                }
            }
        }
        properties.insert(
            "description".into(),
            self.get_string(pointer, self.symbols.description)?.into(),
        );
        let actions = self
            .action_names(pointer)
            .map(|(_, names)| names)
            .unwrap_or_default();
        let bounds = (|| -> Result<_> {
            let component = self.object(unsafe { (self.symbols.component)(pointer) })?;
            let mut error = self.error();
            let raw = unsafe { (self.symbols.bounds)(component.pointer, 0, &mut error.pointer) };
            if raw.is_null() {
                return Err("native geometry unavailable".into());
            }
            let rect = unsafe {
                Bounds {
                    x: (*raw).x,
                    y: (*raw).y,
                    width: (*raw).width,
                    height: (*raw).height,
                }
            };
            unsafe {
                (self.free)(raw.cast());
            }
            error.checked(rect)
        })()
        .ok();
        let identifier = properties
            .get("id")
            .or_else(|| properties.get("accessible-id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        Ok(Details {
            role,
            name,
            identifier,
            states,
            actions,
            bounds,
            properties,
        })
    }
    fn child_count(&self, object: &Object) -> Result<usize> {
        let count = self.get_int(object.pointer, self.symbols.child_count)?;
        if count < 0 {
            return Err("invalid native child count".into());
        }
        Ok(count as usize)
    }
    fn child(&self, object: &Object, index: u32) -> Result<Object> {
        if index > i32::MAX as u32 {
            return Err("invalid native child index".into());
        }
        unsafe {
            (self.symbols.cache)(object.pointer, 0);
            (self.symbols.clear)(object.pointer);
        }
        let mut error = self.error();
        let pointer =
            unsafe { (self.symbols.child)(object.pointer, index as i32, &mut error.pointer) };
        let object = self.object(pointer)?;
        error.checked(object)
    }
    fn actions(&self, object: &Object) -> Result<(Object, Vec<String>)> {
        self.action_names(object.pointer)
    }
    fn invoke(&self, iface: &Object, index: usize) -> Result<bool> {
        let mut error = self.error();
        let result =
            unsafe { (self.symbols.invoke)(iface.pointer, index as i32, &mut error.pointer) };
        error.checked(result != 0)
    }
}
