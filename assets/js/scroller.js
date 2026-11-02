// Minimal scrollytelling driver shared by all stories.
// Usage: scroller(document.querySelectorAll(".step"), (index, el) => render(index));
// Fires when a step's middle crosses the middle of the viewport, in either direction.
export function scroller(steps, onStep) {
  let current = -1;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const i = Number(e.target.dataset.step);
        if (i !== current) {
          current = i;
          steps.forEach((s) => s.classList.toggle("is-active", Number(s.dataset.step) === i));
          onStep(i, e.target);
        }
      }
    },
    {
      // On phones the graphic fills the top of the screen, so a step takes over
      // when it reaches the lower part of the screen, below the chart.
      rootMargin: window.innerWidth < 1000 ? "-75% 0px -25% 0px" : "-50% 0px -50% 0px",
      threshold: 0,
    }
  );
  steps.forEach((s, i) => {
    s.dataset.step = i;
    io.observe(s);
  });
  return io;
}
