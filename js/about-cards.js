document.addEventListener('DOMContentLoaded', function () {
  var cards = document.querySelectorAll('.project-card');
  if (!cards.length) return;

  var isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (isMobile) return;

  var MAX_ROTATION = 15;

  cards.forEach(function (card) {
    card.addEventListener('mousemove', function (e) {
      var rect = card.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var centerX = rect.width / 2;
      var centerY = rect.height / 2;

      var rotateY = ((x - centerX) / centerX) * MAX_ROTATION;
      var rotateX = ((centerY - y) / centerY) * MAX_ROTATION;

      card.style.transform =
        'perspective(800px) rotateX(' + rotateX + 'deg) rotateY(' + rotateY + 'deg) scale3d(1.02, 1.02, 1.02)';
      card.style.willChange = 'transform';

      var percentX = ((x / rect.width) * 100).toFixed(1);
      var percentY = ((y / rect.height) * 100).toFixed(1);
      card.style.setProperty('--mouse-x', percentX + '%');
      card.style.setProperty('--mouse-y', percentY + '%');
    });

    card.addEventListener('mouseleave', function () {
      card.style.transform = '';
      card.style.willChange = '';
    });
  });
});
