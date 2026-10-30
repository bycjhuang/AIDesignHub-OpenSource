(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const dialog=$('websiteAccountDialog');
  document.querySelector('.website-toolbar').addEventListener('click',event=>event.stopPropagation());
  for(const surface of document.querySelectorAll('.website-dialog'))surface.addEventListener('click',event=>event.stopPropagation());
  const products=$('websiteProducts'),panel=$('websiteProductsPanel');
  function toggleProducts(open){products.setAttribute('aria-expanded',String(open));panel.hidden=!open;products.querySelector('.lucide-chevron-down').classList.toggle('bycj-product-chevron-open',open);}
  products.addEventListener('click',()=>toggleProducts(products.getAttribute('aria-expanded')!=='true'));
  $('websiteProductsClose').addEventListener('click',()=>{toggleProducts(false);products.focus();});
  $('websiteProductMatrix').addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden){event.stopPropagation();toggleProducts(false);products.focus();}});
  // Website actions retain focus and must not trigger desktop shortcuts.
  document.querySelector('.website-toolbar').addEventListener('keydown',event=>event.stopPropagation());
  let user=null,pending=null,register=false;
  async function request(path,body){
    const response=await fetch('/api/account/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'账号服务暂时不可用，请稍后重试。');return data;
  }
  function message(text){$('websiteAuthMessage').textContent=text;$('websiteAuthMessage').hidden=!text;}
  function mode(value){register=value;$('websitePasswordLabel').hidden=register;$('websitePassword').required=!register;$('websiteLoginSubmit').textContent=register?'发送 BYCJ 注册验证邮件':'登录并继续';$('websiteRegister').textContent=register?'已有账号？返回登录':'首次使用？注册 BYCJ 账号';message('');}
  function refreshAccount(){ $('websiteAccount').textContent=user?(user.email||'已登录'):'BYCJ 登录 / 注册';$('websiteAccount').dataset.compactLabel=user?'我的账号':'登录 / 注册';$('websiteLogout').hidden=!user; }
  function openAccount(){mode(false);dialog.showModal();}
  async function download(kind){pending=kind;if(!user)return openAccount();try{const result=await request('me');user=result.user;window.location.assign('/api/downloads/'+kind);pending=null;}catch(error){user=null;refreshAccount();openAccount();message(error.message);}}
  $('websiteAccount').addEventListener('click',openAccount);
  $('websiteDownload').addEventListener('click',()=>download('windows'));
  $('websiteSource').addEventListener('click',()=>download('source'));
  $('websiteRegister').addEventListener('click',()=>mode(!register));
  $('websiteLoginForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('websiteLoginSubmit');button.disabled=true;message('');
    try{
      const email=$('websiteEmail').value.trim();
      if(register){await request('register/request',{email});message('验证邮件已发送。请打开邮件，在 BYCJ 网站完成注册，然后回到这里登录下载。');return;}
      const result=await request('login',{email,password:$('websitePassword').value});user=result.user;$('websitePassword').value='';refreshAccount();dialog.close();if(pending)download(pending);
    }catch(error){message(error.message);}finally{button.disabled=false;}
  });
  $('websiteLogout').addEventListener('click',async()=>{try{await request('logout',{});user=null;refreshAccount();message('已退出登录。');}catch(error){message(error.message);}});
  $('websiteReset').addEventListener('click',()=>{for(const key of Object.keys(localStorage))if(key.startsWith('adh-public-canvas-v1:'))localStorage.removeItem(key);location.reload();});
  $('websiteFullscreen').addEventListener('click',()=>{const promise=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();promise?.catch(()=>{});});
  request('me').then(result=>{user=result.user;refreshAccount();}).catch(()=>{});
})();
