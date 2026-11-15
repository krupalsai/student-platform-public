import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const slugify = (s:string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
export const formatCurrency = (n:number) => `₹${n.toLocaleString("en-IN")}`;
export const formatDate = (s:string) => new Date(s).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});
