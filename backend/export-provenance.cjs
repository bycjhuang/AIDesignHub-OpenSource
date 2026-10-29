'use strict';
const identity = require('../assets/release-identity.json');
const mark = `Powered by AIDesignHub · v${identity.version} · ${identity.releaseId.slice(-12)}`;

function withPresentationProvenance(presentation) {
  const slides = [], stamped = new WeakSet();
  const add = presentation.addSlide.bind(presentation), write = presentation.writeFile.bind(presentation);
  presentation.addSlide = (...args) => { const slide = add(...args); slides.push(slide); return slide; };
  presentation.writeFile = (...args) => {
    presentation.subject = `${presentation.subject || 'AIDesignHub export'} | ${identity.releaseId} | ${identity.sourceCanary}`;
    for (const slide of slides) if (!stamped.has(slide)) {
      slide.addText(mark, { x: 7.3, y: 7.34, w: 5.65, h: .12, fontFace: 'Arial', fontSize: 5.5, color: '727788', align: 'right', margin: 0, transparency: 8 });
      stamped.add(slide);
    }
    return write(...args);
  };
  return presentation;
}
module.exports = { mark, identity, withPresentationProvenance };
