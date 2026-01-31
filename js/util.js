export function el(html){
  const t=document.createElement('template');
  t.innerHTML=html.trim();
  return t.content.firstElementChild;
}
export async function modalConfirm(title, htmlBody){
  return new Promise(resolve=>{
    const bd=document.createElement('div');
    bd.className='modal-backdrop';
    bd.innerHTML=`
      <div class="modal">
        <h3>${title}</h3>
        <p>${htmlBody}</p>
        <div class="actions">
          <button id="cancel">취소</button>
          <button class="primary" id="ok">확정</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    bd.querySelector('#cancel').onclick=()=>{bd.remove();resolve(false);};
    bd.querySelector('#ok').onclick=()=>{bd.remove();resolve(true);};
  });
}
