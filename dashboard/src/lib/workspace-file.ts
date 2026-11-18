export async function readFile(file: File) {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read " + file.name));
    reader.readAsDataURL(file);
  });
  return {
    path: file.webkitRelativePath?.split("/").slice(1).join("/") || file.name,
    data,
  };
}
