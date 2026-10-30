(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const dialog=$('websiteIntroDialog'),floating=$('websiteIntroFloat'),video=$('websiteIntroVideo');
  let mode='closed',resumeTime=0;
  const status=$('websiteIntroStatus'),error=$('websiteIntroError');
  function load(){
    if(!video.hasAttribute('src')){video.src=video.dataset.source;video.load();}
  }
  function play(){
    load();
    video.play()?.catch(()=>{status.textContent='点击视频播放按钮开始观看';});
  }
  function close(){
    mode='closed';resumeTime=Number.isFinite(video.currentTime)?video.currentTime:resumeTime;
    video.pause();video.removeAttribute('src');video.load();floating.hidden=true;
    if(dialog.open)dialog.close();
  }
  function large(){
    const start=mode==='closed';mode='large';floating.hidden=true;
    $('websiteIntroLargeHost').append(video);
    if(!dialog.open)dialog.showModal();
    if(start)play();
  }
  function small(){
    const start=mode==='closed';mode='small';
    $('websiteIntroSmallHost').append(video);floating.hidden=false;
    if(dialog.open)dialog.close();
    if(start)play();
  }
  async function fullscreen(){
    load();
    try{
      if(video.requestFullscreen)await video.requestFullscreen();
      else if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();
      else throw new Error('Fullscreen unavailable');
      if(video.paused)play();
    }catch{
      large();status.textContent='可使用视频右下角的全屏按钮观看';
    }
  }
  for(const surface of [dialog,floating]){
    surface.addEventListener('click',event=>event.stopPropagation());
    surface.addEventListener('keydown',event=>{
      event.stopPropagation();
      if(event.key==='Escape'&&video.matches(':fullscreen')){event.preventDefault();document.exitFullscreen?.().catch(()=>{});}
    });
    surface.addEventListener('keyup',event=>event.stopPropagation());
  }
  for(const button of document.querySelectorAll('[data-intro-close]'))button.addEventListener('click',close);
  for(const button of document.querySelectorAll('[data-intro-fullscreen]'))button.addEventListener('click',fullscreen);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',()=>{if(!dialog.open&&mode==='large')close();});
  $('websiteIntro').addEventListener('click',large);
  $('websiteIntroExpand').addEventListener('click',large);
  $('websiteIntroMinimize').addEventListener('click',small);
  $('websiteIntroRetry').addEventListener('click',()=>{error.hidden=true;video.load();play();});
  $('websiteIntroSound').addEventListener('click',()=>{video.muted=!video.muted;if(video.paused)play();});
  video.addEventListener('loadedmetadata',()=>{if(resumeTime>0){video.currentTime=Math.min(resumeTime,Math.max(0,video.duration-.1));resumeTime=0;}});
  video.addEventListener('volumechange',()=>{
    $('websiteIntroSound').textContent=video.muted?'开启声音':'静音';
    status.textContent=video.muted?'静音播放中，可开启声音':'已开启声音';
  });
  video.addEventListener('error',()=>{if(mode!=='closed'&&video.hasAttribute('src'))error.hidden=false;});
  video.addEventListener('playing',()=>{error.hidden=true;});
  // Only an explicit sidebar action reopens the small player. No dismissal
  // timer, outside-click handler or route cleanup can close it.
  document.addEventListener('click',event=>{
    const button=event.target instanceof Element?event.target.closest('.sidebar .nav-item[data-view]'):null;
    if(button&&!button.disabled&&!button.closest('[hidden]'))small();
  },true);
  large();
})();
