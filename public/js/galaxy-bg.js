// ==================== 璀璨银河背景模块（共享） ====================
// 用法: <div id="galaxy-bg"></div> + GalaxyBG.init('galaxy-bg')
var GalaxyBG = (function() {
  'use strict';
  var scene, camera, renderer, containerEl;
  var starCloud, galacticHalo, galaxySystem, dustNebula, darkDust, coreGlow, brightStarField;
  var mouseX=0, mouseY=0, starClock;
  var CLOUD=65000, HALO=42000, STAR=210000, DUST=95000, DARK=28000, CORE=18000, BRIGHT=1600;

  function noise(c,a){c.r+=(Math.random()-.5)*a;c.g+=(Math.random()-.5)*a;c.b+=(Math.random()-.5)*a;c.r=Math.max(0,Math.min(1,c.r));c.g=Math.max(0,Math.min(1,c.g));c.b=Math.max(0,Math.min(1,c.b));}

  function init(id) {
    containerEl = typeof id === 'string' ? document.getElementById(id) : id;
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000001, 0.00082);

    camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 1200);
    camera.position.set(0, 32, 64);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.55;
    containerEl.appendChild(renderer.domElement);

    createStarCloud(); createGalacticHalo(); createGalaxyStars();
    createDustNebula(); createDarkDust(); createCoreGlow(); createBrightStarField();

    scene.rotation.x = 0.34; scene.rotation.z = -0.16;

    window.addEventListener('resize', function() {
      camera.aspect = window.innerWidth/window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
    document.addEventListener('mousemove', function(e) {
      mouseX = (e.clientX - window.innerWidth/2) * 0.0005;
      mouseY = (e.clientY - window.innerHeight/2) * 0.0005;
    });

    starClock = new THREE.Clock();
    animate();
  }

  function createStarCloud() {
    var geo = new THREE.BufferGeometry();
    var p = new Float32Array(CLOUD*3), c = new Float32Array(CLOUD*3);
    for (var i=0;i<CLOUD;i++) {
      var th=Math.random()*Math.PI*2, ph=Math.acos(Math.random()*2-1);
      var r=360+Math.pow(Math.random(),1.05)*280;
      p[i*3]=r*Math.sin(ph)*Math.cos(th);p[i*3+1]=r*Math.cos(ph)*0.7;p[i*3+2]=r*Math.sin(ph)*Math.sin(th);
      var cc=new THREE.Color(Math.random()<0.55?'#1E293B':'#312E81');
      cc.offsetHSL((Math.random()-.5)*0.12,0.18,(Math.random()-.5)*0.18);
      c[i*3]=cc.r*0.42;c[i*3+1]=cc.g*0.42;c[i*3+2]=cc.b*0.6;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(p,3));
    geo.setAttribute('color',new THREE.BufferAttribute(c,3));
    starCloud=new THREE.Points(geo,mat('u',950,1.2,'p.y+=sin(u*0.3+length(p.xz)*0.01)*1.2',0.35,'exp(-d*1.8)'));
    scene.add(starCloud);
  }

  function createGalacticHalo() {
    var geo=new THREE.BufferGeometry(),p=new Float32Array(HALO*3),c=new Float32Array(HALO*3);
    var stops=[new THREE.Color('#5D34D0'),new THREE.Color('#FF006E'),new THREE.Color('#00F0FF'),new THREE.Color('#FFD26A')];
    for(var i=0;i<HALO;i++){
      var r=28+Math.pow(Math.random(),0.72)*335,arm=i%4;
      var th=arm*Math.PI*0.5+Math.log(r)*2.35+(Math.random()-.5)*(0.65+r*0.002);
      var hz=(Math.random()-.5)*r*0.34;
      p[i*3]=Math.cos(th)*r+Math.cos(th+Math.PI*0.5)*hz;
      p[i*3+2]=Math.sin(th)*r+Math.sin(th+Math.PI*0.5)*hz;
      p[i*3+1]=(Math.random()-.5)*(34/(r*0.035+1));
      var b=Math.min(0.999,r/363),hc;
      if(b<0.34)hc=stops[3].clone().lerp(stops[1],b/0.34);
      else if(b<0.68)hc=stops[1].clone().lerp(stops[0],(b-0.34)/0.34);
      else hc=stops[0].clone().lerp(stops[2],(b-0.68)/0.32);
      hc.multiplyScalar(0.16+Math.random()*0.24);
      c[i*3]=hc.r;c[i*3+1]=hc.g;c[i*3+2]=hc.b;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(p,3));
    geo.setAttribute('color',new THREE.BufferAttribute(c,3));
    galacticHalo=new THREE.Points(geo,mat('u',1150,1.05,'p.y+=sin(u*0.22+length(p.xz)*0.018)*1.05',0.42,'smoothstep(0.5,0.0,d)'));
    scene.add(galacticHalo);
  }

  function createGalaxyStars() {
    var geo=new THREE.BufferGeometry(),p=new Float32Array(STAR*3),c=new Float32Array(STAR*3);
    var stops=[new THREE.Color('#FFFFFF'),new THREE.Color('#FFF1C8'),new THREE.Color('#FFD26A'),new THREE.Color('#FF8A4C'),new THREE.Color('#A855F7'),new THREE.Color('#38BDF8'),new THREE.Color('#EC4899'),new THREE.Color('#1E293B')];
    for(var i=0;i<STAR;i++){
      var x,y,z,r;
      if(i<STAR*0.32){
        r=Math.pow(Math.random(),1.6)*10;
        var th=Math.random()*Math.PI*2,ph=Math.acos(Math.random()*2-1);
        x=r*Math.sin(ph)*Math.cos(th);y=r*Math.cos(ph)*0.35;z=r*Math.sin(ph)*Math.sin(th);
        var t=r/10,bc=stops[0].clone().lerp(stops[1],t*0.5);bc.lerp(stops[2],t);noise(bc,0.12);
        c[i*3]=bc.r*1.7;c[i*3+1]=bc.g*1.6;c[i*3+2]=bc.b*1.5;
      }else{
        r=Math.pow(Math.random(),1.06)*315+12;
        var arm=i%4,sf=0.28,aa=(arm*Math.PI*2)/4,ca=aa+Math.log(r)/sf;
        var ro=(Math.pow(Math.random(),2.4)*(Math.random()<0.5?1:-1))*0.24*r;
        x=Math.cos(ca)*r+Math.cos(Math.random()*Math.PI*2)*ro;
        z=Math.sin(ca)*r+Math.sin(Math.random()*Math.PI*2)*ro;
        y=(Math.random()-.5)*(50/(r*0.09+1));
        var bc,t2;
        if(r<45){t2=(r-12)/33;bc=stops[2].clone().lerp(stops[3],t2);}
        else if(r<100){t2=(r-45)/55;bc=stops[3].clone().lerp(stops[4],t2);}
        else if(r<170){t2=(r-100)/70;bc=stops[4].clone().lerp(stops[5],t2);}
        else if(r<230){t2=(r-170)/60;bc=stops[5].clone().lerp(stops[6],t2);}
        else{t2=(r-230)/52;bc=stops[6].clone().lerp(stops[7],t2);}
        if(Math.random()<0.06)bc.lerp(stops[Math.floor(Math.random()*6)],0.35);
        noise(bc,0.18);c[i*3]=bc.r*1.35;c[i*3+1]=bc.g*1.25;c[i*3+2]=bc.b*1.45;
      }
      p[i*3]=x;p[i*3+1]=y;p[i*3+2]=z;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(p,3));
    geo.setAttribute('color',new THREE.BufferAttribute(c,3));
    galaxySystem=new THREE.Points(geo,matCore('u',280,0.92,'p.y+=sin(u*1.1+length(p.xz)*0.045)*0.35','(0.65+0.35*sin(u*3.2+length(p.xz)*0.18))'));
    scene.add(galaxySystem);
  }

  function createDustNebula() {
    var geo=new THREE.BufferGeometry(),p=new Float32Array(DUST*3),c=new Float32Array(DUST*3);
    var dc=['#C084FC','#F472B6','#FB923C','#22D3EE','#FFD26A','#FFFFFF'];
    for(var i=0;i<DUST;i++){
      var r=Math.pow(Math.random(),0.82)*340+8,arm=i%4,sf=0.27;
      var aa=(arm*Math.PI*2)/4,ca=aa+Math.log(r)/sf,ro=(Math.random()-.5)*0.62*r;
      p[i*3]=Math.cos(ca)*r+Math.cos(Math.random()*Math.PI*2)*ro;
      p[i*3+2]=Math.sin(ca)*r+Math.sin(Math.random()*Math.PI*2)*ro;
      p[i*3+1]=(Math.random()-.5)*(70/(r*0.075+1));
      var rd=Math.random(),dd;
      if(rd<0.25)dd=new THREE.Color(dc[0]);else if(rd<0.45)dd=new THREE.Color(dc[1]);else if(rd<0.65)dd=new THREE.Color(dc[2]);else if(rd<0.82)dd=new THREE.Color(dc[3]);else if(rd<0.92)dd=new THREE.Color(dc[4]);else dd=new THREE.Color(dc[5]);
      dd.multiplyScalar(0.24+Math.random()*0.32);c[i*3]=dd.r;c[i*3+1]=dd.g;c[i*3+2]=dd.b;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(p,3));
    geo.setAttribute('color',new THREE.BufferAttribute(c,3));
    dustNebula=new THREE.Points(geo,mat('u',780,0.9,'p.y+=sin(u*0.55+length(p.xz)*0.035)*0.9',0.68,'exp(-d*2.2)'));
    scene.add(dustNebula);
  }

  function createDarkDust() {
    var geo=new THREE.BufferGeometry(),p=new Float32Array(DARK*3),c=new Float32Array(DARK*3);
    for(var i=0;i<DARK;i++){
      var r=Math.pow(Math.random(),1.28)*320+15,an=Math.log(r)*0.33+(i%12)*(Math.PI*2/12);
      var of=(Math.random()-.5)*0.28*r;
      p[i*3]=Math.cos(an)*r+of*Math.sin(an);p[i*3+1]=(Math.random()-.5)*18;p[i*3+2]=Math.sin(an)*r-of*Math.cos(an);
      var dc2=new THREE.Color('#050508');dc2.multiplyScalar(0.45+Math.random()*0.25);c[i*3]=dc2.r;c[i*3+1]=dc2.g;c[i*3+2]=dc2.b;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(p,3));
    geo.setAttribute('color',new THREE.BufferAttribute(c,3));
    darkDust=new THREE.Points(geo,matDark('u',620,0.5,'p.y+=sin(u*0.4+length(p.xz)*0.02)*0.5'));
    scene.add(darkDust);
  }

  function createCoreGlow() {
    var geo=new THREE.BufferGeometry(),p=new Float32Array(CORE*3),c=new Float32Array(CORE*3);
    for(var i=0;i<CORE;i++){
      var r=Math.pow(Math.random(),1.65)*13,th=Math.random()*Math.PI*2,ph=Math.acos(Math.random()*2-1);
      p[i*3]=r*Math.sin(ph)*Math.cos(th);p[i*3+1]=r*Math.cos(ph)*0.3;p[i*3+2]=r*Math.sin(ph)*Math.sin(th);
      var cc=new THREE.Color('#FFFFFF');cc.lerp(new THREE.Color('#FFD26A'),r/13);cc.multiplyScalar(1.45+Math.random()*0.9);
      c[i*3]=cc.r;c[i*3+1]=cc.g;c[i*3+2]=cc.b;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(p,3));
    geo.setAttribute('color',new THREE.BufferAttribute(c,3));
    coreGlow=new THREE.Points(geo,matCore('u',260,1.15,'p.y+=sin(u*1.8+length(p.xz)*0.8)*0.18','(1.0+0.45*sin(u*2.5+length(p.xz)*0.55))'));
    scene.add(coreGlow);
  }

  function createBrightStarField() {
    var geo=new THREE.BufferGeometry(),p=new Float32Array(BRIGHT*3),c=new Float32Array(BRIGHT*3),s=new Float32Array(BRIGHT);
    var scs=['#FFFFFF','#FFF8E7','#FFD26A','#38BDF8','#A78BFA'];
    for(var i=0;i<BRIGHT;i++){
      var r=35+Math.pow(Math.random(),0.9)*390,th=Math.random()*Math.PI*2;
      p[i*3]=Math.cos(th)*r;p[i*3+1]=(Math.random()-.5)*155;p[i*3+2]=Math.sin(th)*r;
      var sc=new THREE.Color(scs[Math.floor(Math.random()*scs.length)]);sc.multiplyScalar(1.0+Math.random()*0.9);
      c[i*3]=sc.r;c[i*3+1]=sc.g;c[i*3+2]=sc.b;s[i]=0.65+Math.random()*1.65;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(p,3));
    geo.setAttribute('color',new THREE.BufferAttribute(c,3));
    geo.setAttribute('aSize',new THREE.BufferAttribute(s,1));
    brightStarField=new THREE.Points(geo,new THREE.ShaderMaterial({
      uniforms:{uTime:{value:0}},
      vertexShader:'attribute float aSize;uniform float uTime;varying vec3 vColor;varying float vPulse;void main(){vColor=color;vPulse=0.65+0.35*sin(uTime*2.4+aSize*9.0+position.x*0.02);vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=aSize*(900.0/-mv.z)*vPulse;gl_Position=projectionMatrix*mv;}',
      fragmentShader:'varying vec3 vColor;varying float vPulse;void main(){vec2 c=gl_PointCoord-vec2(0.5);float d=length(c);if(d>0.5)discard;float core=exp(-d*18.0);float rays=(1.0-smoothstep(0.02,0.5,abs(c.x)))*0.18+(1.0-smoothstep(0.02,0.5,abs(c.y)))*0.18;float halo=exp(-d*3.0)*0.55;gl_FragColor=vec4(vColor,(core+halo+rays)*vPulse);}',
      transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,vertexColors:true
    }));
    scene.add(brightStarField);
  }

  // ---- shader helpers ----
  function mat(uname,ps,wa,vsLine,alpha,fsFormula) {
    var u={};u[uname]={value:0};
    return new THREE.ShaderMaterial({
      uniforms:u,_name:uname,
      vertexShader:'varying vec3 vColor;void main(){vColor=color;vec3 p=position;'+vsLine+';vec4 mv=modelViewMatrix*vec4(p,1.0);gl_PointSize=('+ps+'.0/-mv.z)*('+wa+');gl_Position=projectionMatrix*mv;}',
      fragmentShader:'varying vec3 vColor;void main(){vec2 c=gl_PointCoord-vec2(0.5);float d=length(c);if(d>0.5)discard;gl_FragColor=vec4(vColor,'+fsFormula+'*'+alpha+');}',
      transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,vertexColors:true
    });
  }
  function matCore(uname,ps,alpha,vsLine,sizeExpr) {
    var u={};u[uname]={value:0};
    return new THREE.ShaderMaterial({
      uniforms:u,_name:uname,
      vertexShader:'varying vec3 vColor;void main(){vColor=color;vec3 p=position;'+vsLine+';vec4 mv=modelViewMatrix*vec4(p,1.0);gl_PointSize=('+ps+'.0/-mv.z)*'+sizeExpr+';gl_Position=projectionMatrix*mv;}',
      fragmentShader:'varying vec3 vColor;void main(){vec2 c=gl_PointCoord-vec2(0.5);float d=length(c);if(d>0.5)discard;float core=exp(-d*8.5);float halo=exp(-d*3.2)*0.45;gl_FragColor=vec4(vColor,(core+halo)*'+alpha+');}',
      transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,vertexColors:true
    });
  }
  function matDark(uname,ps,alpha,vsLine) {
    var u={};u[uname]={value:0};
    return new THREE.ShaderMaterial({
      uniforms:u,_name:uname,
      vertexShader:'varying vec3 vColor;void main(){vColor=color;vec3 p=position;'+vsLine+';vec4 mv=modelViewMatrix*vec4(p,1.0);gl_PointSize=('+ps+'.0/-mv.z);gl_Position=projectionMatrix*mv;}',
      fragmentShader:'varying vec3 vColor;void main(){vec2 c=gl_PointCoord-vec2(0.5);float d=length(c);if(d>0.5)discard;gl_FragColor=vec4(vColor,exp(-d*2.0)*'+alpha+');}',
      transparent:true,blending:THREE.NormalBlending,depthWrite:false,vertexColors:true
    });
  }

  function animate() {
    requestAnimationFrame(animate);
    var t=starClock.getElapsedTime();
    if(starCloud){starCloud.rotation.y=-t*0.018;starCloud.material.uniforms.u.value=t;}
    if(galacticHalo){galacticHalo.rotation.y=-t*0.028;galacticHalo.material.uniforms.u.value=t;}
    if(galaxySystem){galaxySystem.rotation.y=-t*0.055;galaxySystem.material.uniforms.u.value=t;}
    if(dustNebula){dustNebula.rotation.y=-t*0.038;dustNebula.material.uniforms.u.value=t;}
    if(darkDust){darkDust.rotation.y=-t*0.065;darkDust.material.uniforms.u.value=t;}
    if(coreGlow){coreGlow.rotation.y=-t*0.08;coreGlow.material.uniforms.u.value=t;}
    if(brightStarField){brightStarField.rotation.y=-t*0.012;brightStarField.material.uniforms.uTime.value=t;}
    camera.position.x=Math.sin(t*0.12)*6;
    camera.position.y=32+Math.cos(t*0.18)*3.2;
    camera.position.z=64+Math.sin(t*0.08)*3;
    camera.lookAt(0,1.5,-8);
    renderer.render(scene,camera);
  }

  return { init: init };
})();
