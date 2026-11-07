'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'../..');let count=0;
function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(['node_modules','.git','data','uploads'].includes(entry.name))continue;
    const file=path.join(dir,entry.name);
    if(entry.isDirectory()){walk(file);continue;}
    if(!/\.(js|html)$/.test(entry.name))continue;
    const text=fs.readFileSync(file,'utf8');
    if(entry.name.endsWith('.js')){new vm.Script(text,{filename:file});count++;}
    else{let n=0;for(const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){n++;if(/\bsrc\s*=/.test(match[1])||!match[2].trim())continue;new vm.Script(match[2],{filename:file+' inline script '+n});count++;}}
  }
}
walk(root);console.log('PASS '+count+' JavaScript files/inline blocks parsed without syntax errors');
